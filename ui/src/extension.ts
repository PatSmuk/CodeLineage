import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";

interface Server {}

interface Link {
  fileName: string;
  line: number;
}

interface Lineage {
  lineage: string;
  link: Link;
}
interface FunctionLineages {
  funcName: string;
  struct?: string;
  lineages: Lineage[];
}

interface GetLineagesResponse {
  functions: FunctionLineages[];
}

interface Server {
  process: ChildProcess;

  getLineages(
    fileName: string,
    callback: (response: GetLineagesResponse) => void
  ): void;
}

function createServer(rootPath: string): Server {
  const process = spawn("codelineage-server", [rootPath], {
    cwd: rootPath, // Optional: set working directory
    shell: true,
  });

  let serverDied = false;
  const pendingCallbacks: ((lineages: GetLineagesResponse) => void)[] = [];

  // Handle stdout
  process.stdout.on("data", (data) => {
    try {
      const jsonData = JSON.parse(data.toString()) as GetLineagesResponse;
      console.log("Received:", jsonData);
      const callback = pendingCallbacks.shift()!;
      callback(jsonData);
    } catch (error) {
      console.error("Error parsing JSON:", error);
    }
  });

  // Handle stderr
  process.stderr.on("data", (data) => {
    console.error(`Go process stderr: ${data}`);
  });
  // Handle process exit
  process.on("close", (code) => {
    console.log(`Go process exited with code ${code}`);
    serverDied = true;
  });

  function getLineages(
    fileName: string,
    callback: (response: GetLineagesResponse) => void
  ): void {
    if (serverDied) {
      return;
    }
    process.stdin.write(
      JSON.stringify({
        type: "GET_LINEAGES",
        fileName,
      })
    );
    pendingCallbacks.push(callback);
  }

  return {
    process,
    getLineages,
  };
}

let rootPath = "";

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "codelineage.analyzeGoCode",
    () => {}
  );
  context.subscriptions.push(disposable);

  // Get the root folder of the current workspace
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder found");
    return;
  }
  rootPath = workspaceFolders[0].uri.fsPath;
  const server = createServer(rootPath);

  // Clean up server process if extension is deactivated.
  context.subscriptions.push(
    new vscode.Disposable(() => {
      server.process.kill();
    })
  );

  // Register the CodeLens provider
  const selector: vscode.DocumentSelector = { language: "go" };
  disposable = vscode.languages.registerCodeLensProvider(
    selector,
    new LineageCodeLensProvider(server)
  );
  context.subscriptions.push(disposable);

  // Command to handle custom styling
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "lineage.clickLineage",
      async (lineage: Lineage) => {
        try {
          // Open the file as a text document
          const document = await vscode.workspace.openTextDocument(
            path.join(rootPath, lineage.link.fileName)
          );

          // Show the document in the editor
          const editor = await vscode.window.showTextDocument(document);

          // Navigate to the specific line and reveal it
          const position = new vscode.Position(lineage.link.line - 1, 0); // Line and column
          const range = new vscode.Range(position, position);
          editor.revealRange(range, vscode.TextEditorRevealType.AtTop);

          // Optionally set the cursor at the line
          editor.selection = new vscode.Selection(position, position);
        } catch (error) {
          vscode.window.showErrorMessage(`Could not open file: ${error}`);
        }

        //   const panel = vscode.window.createWebviewPanel(
        //     "lineageDetails",
        //     "Lineage",
        //     vscode.ViewColumn.Beside,
        //     {}
        //   );
        //   panel.webview.html = `
        //     <style>
        //         .lineage-box {
        //             background-color: red;
        //             color: white;
        //             padding: 10px;
        //             border-radius: 5px;
        //             display: inline-block;
        //         }
        //     </style>
        //     <div class="lineage-box">
        //         ${lineage.lineage}
        //     </div>
        // `;
      }
    )
  );
}

class LineageCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private server: Server) {}

  provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    return new Promise((resolve) => {
      this.server.getLineages(document.fileName, (response) => {
        const codeLenses: vscode.CodeLens[] = [];

        for (const func of response.functions) {
          const functionRegex = new RegExp(`func\\s+(${func.funcName})\\s*\\(`);

          for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const match = line.text.match(functionRegex);

            if (match) {
              for (const lineage of func.lineages) {
                const range = new vscode.Range(
                  new vscode.Position(i, 0),
                  new vscode.Position(i, line.text.length)
                );

                const codeLens = new vscode.CodeLens(range, {
                  title: lineage.lineage,
                  command: "lineage.clickLineage",
                  arguments: [lineage],
                });

                codeLenses.push(codeLens);
              }
            }
          }
        }

        if (!token.isCancellationRequested) {
          resolve(codeLenses);
        }
      });
    });
  }
}
