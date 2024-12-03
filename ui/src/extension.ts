import { spawn } from "child_process";
import * as vscode from "vscode";
import {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  JSONRPCEndpoint,
  LspClient,
  SymbolInformation,
  SymbolKind,
} from "./ts-lsp-client";

interface RecursiveCallHierarchyIncomingCall extends CallHierarchyIncomingCall {
  from: RecursiveCallHierarchyItem;
}

interface RecursiveCallHierarchyItem extends CallHierarchyItem {
  incomingCalls: RecursiveCallHierarchyIncomingCall[];
}

let lspClient: LspClient | null = null;

export async function activate(context: vscode.ExtensionContext) {
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

  const lspProcess = spawn("gopls", {
    shell: true,
    stdio: "pipe",
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
    new LineageCodeLensProvider()
  );
  context.subscriptions.push(disposable);

  // Command to handle custom styling
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeLineage.showCallGraph",
      async (node: RecursiveCallHierarchyItem) => {
        const panel = vscode.window.createWebviewPanel(
          "lineageDetails",
          "Lineage",
          vscode.ViewColumn.Beside,
          {}
        );
        panel.webview.html = `
            <style>
                .lineage-box {
                    background-color: red;
                    color: white;
                    padding: 10px;
                    border-radius: 5px;
                    display: inline-block;
                }
            </style>
            <div class="lineage-box">
            </div>
        `;
      }
    )
  );
}

class LineageCodeLensProvider implements vscode.CodeLensProvider {
  constructor() {}

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    if (!lspClient) {
      return [];
    }

    const results = (await lspClient.documentSymbol({
      textDocument: {
        uri: document.uri.toString(),
      },
    })) as SymbolInformation[] | null;

    if (!results || token.isCancellationRequested) {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];
    const nodesAlreadyVisited = new Map<
      string,
      RecursiveCallHierarchyIncomingCall[]
    >();

    for (const { location, kind } of results) {
      if (token.isCancellationRequested) {
        return [];
      }

      if (kind === SymbolKind.Function) {
        const range = document.lineAt(location.range.start.line).range;

        const prepareResult = await lspClient.prepareCallHierarchy({
          textDocument: {
            uri: document.uri.toString(),
          },
          position: {
            line: location.range.start.line,
            character: location.range.start.character + 5, // hack
          },
        });

        if (!prepareResult) {
          continue;
        }

        const startItem = prepareResult[0];
        const startNode = {
          ...startItem,
          incomingCalls: [],
        } as RecursiveCallHierarchyItem;

        // Recursively fetch the incoming calls and build the tree
        const buildCallHierarchy = async (item: RecursiveCallHierarchyItem) => {
          if (token.isCancellationRequested) {
            return;
          }

          const nodeKey = `${item.uri.toString()}::${item.name}`;
          const maybeIncomingCalls = nodesAlreadyVisited.get(nodeKey);
          if (maybeIncomingCalls) {
            item.incomingCalls = maybeIncomingCalls;
            return;
          }

          const incomingCallsResult = await lspClient!.incomingCalls({
            item,
          });

          if (!incomingCallsResult) {
            return;
          }

          for (const incomingCall of incomingCallsResult) {
            if (incomingCall.from.uri.endsWith("_test.go")) {
              continue;
            }

            const callNode = {
              ...incomingCall.from,
              incomingCalls: [],
            } as RecursiveCallHierarchyItem;

            item.incomingCalls.push({
              from: callNode,
              fromRanges: incomingCall.fromRanges,
            });
            await buildCallHierarchy(callNode); // Recurse into the next level
          }

          nodesAlreadyVisited.set(nodeKey, item.incomingCalls);
        };

        await buildCallHierarchy(startNode);

        // Build paths to bottom from root for code lenses
        const stack = [{ node: startNode, path: "" }];
        while (stack.length > 0) {
          const { node, path } = stack.pop()!;

          // If node is not called from anywhere, it's the root,
          // turn it into a code lens
          if (node.incomingCalls.length === 0) {
            codeLenses.push(
              new vscode.CodeLens(range, {
                title: node.name + path,
                command: "codeLineage.showCallGraph",
              })
            );
          }

          for (const incomingCall of node.incomingCalls) {
            for (const fromRange of incomingCall.fromRanges) {
              const lineOffset =
                fromRange.start.line - incomingCall.from.range.start.line;

              stack.push({
                node: incomingCall.from,
                path: `.${lineOffset}${path}`,
              });
            }
          }
        }
      }
    }

    return codeLenses;
  }
}
