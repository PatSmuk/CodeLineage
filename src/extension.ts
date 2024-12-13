import { JSDOM } from "jsdom";
import { spawn } from "node:child_process";
import * as vscode from "vscode";

import { LineageCodeLensProvider } from "./LineageCodeLensProvider";
import { renderDotToHTML } from "./render";
import { JSONRPCEndpoint, LspClient } from "./ts-lsp-client";

// Used by the viz-js to render the SVG.
global.DOMParser = new JSDOM().window.DOMParser;

const graphvizMap = new Map<string, string>();
const activePanels = new Map<string, vscode.WebviewPanel>();

let lspClient: LspClient | null = null;
let analysisEnabled = true;
const getLspClient = () => (analysisEnabled ? lspClient : null);

export async function activate(context: vscode.ExtensionContext) {
  // Get the root folder of the current workspace
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder found");
    return;
  }
  const rootPath = workspaceFolders[0].uri.fsPath;

  // Create code lens provider
  const codeLensProvider = new LineageCodeLensProvider(
    getLspClient,
    graphvizMap,
    rootPath
  );

  // Connect code lens provider with start and stop commands
  let disposable = vscode.commands.registerCommand("codelineage.start", () => {
    analysisEnabled = true;
    codeLensProvider.notify();
  });
  context.subscriptions.push(disposable);

  disposable = vscode.commands.registerCommand("codelineage.stop", () => {
    analysisEnabled = false;
    codeLensProvider.notify();
  });
  context.subscriptions.push(disposable);

  const lspProcess = spawn("gopls", {
    shell: true,
    stdio: "pipe",
  });

  lspProcess.on("error", (err) => {
    vscode.window.showErrorMessage(
      `Failed to spawn Go language server: ${err}`
    );
  });

  const endpoint = new JSONRPCEndpoint(lspProcess.stdin, lspProcess.stdout);
  lspClient = new LspClient(endpoint);

  await lspClient.initialize({
    processId: process.pid,
    capabilities: {},
    clientInfo: {
      name: "CodeLineage",
      version: "1.0.0",
    },
    rootUri: workspaceFolders[0].uri.toString(),
  });

  await lspClient.initialized();

  // Clean up server process if extension is deactivated.
  context.subscriptions.push(
    new vscode.Disposable(() => {
      lspProcess.kill();
    })
  );

  // Register the CodeLens provider
  const selector: vscode.DocumentSelector = { language: "go" };
  disposable = vscode.languages.registerCodeLensProvider(
    selector,
    codeLensProvider
  );
  context.subscriptions.push(disposable);

  // Command to handle custom styling
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeLineage.showCallGraph",
      async (key: string) => {
        let panel = activePanels.get(key);
        if (panel) {
          panel.reveal();
          return;
        }

        const dotContent = graphvizMap.get(key);
        if (!dotContent) {
          return;
        }

        panel = vscode.window.createWebviewPanel(
          "lineageDetails",
          "Lineage of " + key.split("::")[1],
          vscode.ViewColumn.Beside,
          {
            enableScripts: true, // Enable JavaScript execution
          }
        );
        activePanels.set(key, panel);

        panel.webview.html = await renderDotToHTML(dotContent, rootPath);

        // Receive messages from when the user clicks on nodes
        panel.webview.onDidReceiveMessage(
          async (message) => {
            if (message.type === "nodeClick") {
              const fileUri = message.uri.split(":")[0];
              const line = parseInt(message.uri.split(":")[1] ?? 1) - 1;

              try {
                const document = await vscode.workspace.openTextDocument(
                  vscode.Uri.file(fileUri)
                );
                const editor = await vscode.window.showTextDocument(
                  document,
                  vscode.ViewColumn.One
                );
                const pos = new vscode.Position(line, 0);
                editor.selections = [new vscode.Selection(pos, pos)];
                editor.revealRange(new vscode.Range(pos, pos));
              } catch (error) {
                vscode.window.showErrorMessage(
                  `Failed to open file ${fileUri}: ${error}`
                );
              }
            }
          },
          undefined,
          context.subscriptions
        );

        panel.onDidDispose(() => {
          activePanels.delete(key);
        });
      }
    )
  );
}
