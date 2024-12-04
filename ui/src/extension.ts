import { instance } from "@viz-js/viz";
import { spawn } from "child_process";
import { JSDOM } from "jsdom";
import * as vscode from "vscode";
import { LineageCodeLensProvider } from "./LineageCodeLensProvider";
import { JSONRPCEndpoint, LspClient } from "./ts-lsp-client";

let rootPath: string = "";
global.DOMParser = new JSDOM().window.DOMParser;

let lspClient: LspClient | null = null;
const graphvizMap = new Map<string, string>();

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
  rootPath = workspaceFolders[0].uri.fsPath;

  const lspProcess = spawn(
    "gopls",
    [
      // "-logfile=/Users/pat.smuk/Code/github.com/PatSmuk/CodeLineage/ui/gopls-trace.log",
      // "-rpc.trace",
    ],
    {
      shell: true,
      stdio: "pipe",
    }
  );

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
    new LineageCodeLensProvider(lspClient, graphvizMap, rootPath)
  );
  context.subscriptions.push(disposable);

  // Command to handle custom styling
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeLineage.showCallGraph",
      async (key: string) => {
        const dotContent = graphvizMap.get(key);
        if (!dotContent) {
          return;
        }
        const svgContent = await instance().then((viz) => {
          return viz.renderSVGElement(dotContent);
        });
        console.log('got svg rendered');
        const svgContentWithLinks = makeSVGClickable(svgContent);
        const panel = vscode.window.createWebviewPanel(
          "lineageDetails",
          "Lineage",
          vscode.ViewColumn.Beside,
          {
            enableScripts: true, // Enable JavaScript execution
          }
        );
        panel.webview.html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'none'; img-src vscode-resource:; script-src 'unsafe-inline' vscode-resource:; style-src 'unsafe-inline' vscode-resource:;">
          <style>
            .lineage-box {
              display: flex;
              justify-content: center;
              align-items: center;
              padding: 20px;
            }
            svg {
              width: 100%;
              height: auto;
            }
          </style>
        </head>
        <body>
          <div class="lineage-box">
            ${svgContentWithLinks.outerHTML}
          </div>
          <script>
            window.addEventListener("DOMContentLoaded", () => {
              const vscode = acquireVsCodeApi();
              const nodes = document.querySelectorAll("g[data-node-name]");
              nodes.forEach((node) => {
                node.addEventListener("click", () => {
                  const nodeName = node.getAttribute("data-node-name");
                  const fileUri = node.getAttribute("data-file-uri");
                  vscode.postMessage({ type: "nodeClick", nodeName, uri: fileUri });
                });
              });
            });
          </script>
        </body>
        </html>
        `;

        panel.webview.onDidReceiveMessage(
          async (message) => {
            console.log(message);
            if (message.type === "nodeClick") {
              const nodeName = message.nodeName;
              const fileUri = message.uri;

              try {
                console.log('Trying to open '+fileUri);
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fileUri));
                vscode.window.showTextDocument(document, vscode.ViewColumn.One);
              } catch (error) {
                vscode.window.showErrorMessage(`Failed to open file: ${error}`);
              }
            }
          },
          undefined,
          context.subscriptions
        );
      }
    )
  );
}

function makeSVGClickable(svgElement: SVGElement): SVGElement {
  const nodes = svgElement.querySelectorAll("g.node");
  console.log('making clickable');

  nodes.forEach((node) => {
    const titleElement = node.querySelector("title");
    if (titleElement) {
      const nodeName = titleElement.textContent || "";

      // Assuming the file URI is stored or can be derived
      const fileUri = '/Users/marco.martin/go/src/impression/cmd/impression/server/server.go';
      // const fileUri = `file://path/to/${nodeName}.go`; // Replace with actual logic

      // Add attributes to store the necessary data
      node.setAttribute("data-node-name", nodeName);
      node.setAttribute("data-file-uri", fileUri);
      node.setAttribute("style", "cursor: pointer;");
    }
  });

  return svgElement;
}

// class LineageCodeLensProvider implements vscode.CodeLensProvider {
//   constructor() {}

//   async provideCodeLenses(
//     document: vscode.TextDocument,
//     token: vscode.CancellationToken
//   ): Promise<vscode.CodeLens[]> {
//     if (!lspClient) {
//       return [];
//     }

//     console.log("provideCodeLenses called with " + document.uri.toString());
//     const startTime = new Date();

//     const results = (await lspClient.documentSymbol({
//       textDocument: {
//         uri: document.uri.toString(),
//       },
//     })) as SymbolInformation[] | null;

//     if (!results || token.isCancellationRequested) {
//       return [];
//     }

//     const codeLenses: vscode.CodeLens[] = [];
//     const nodesAlreadyVisited = new Map<
//       string,
//       RecursiveCallHierarchyIncomingCall[]
//     >();
//     let hits = 0;
//     let misses = 0;

//     for (const { location, kind, name } of results) {
//       if (token.isCancellationRequested) {
//         return [];
//       }

//       if (kind === SymbolKind.Function) {
//         const range = document.lineAt(location.range.start.line).range;

//         const prepareResult = await lspClient.prepareCallHierarchy({
//           textDocument: {
//             uri: document.uri.toString(),
//           },
//           position: {
//             line: location.range.start.line,
//             character: location.range.start.character + 5, // hack
//           },
//         });

//         if (!prepareResult) {
//           continue;
//         }

//         const startItem = prepareResult[0];
//         const startNode = {
//           ...startItem,
//           incomingCalls: [],
//         } as RecursiveCallHierarchyItem;
//         const startNodeKey = nodeToKey(startNode);

//         // Recursively fetch the incoming calls and build the tree
//         const buildCallHierarchy = async (
//           item: RecursiveCallHierarchyItem,
//           log: boolean
//         ) => {
//           if (token.isCancellationRequested) {
//             return;
//           }

//           const maybeIncomingCalls = nodesAlreadyVisited.get(nodeToKey(item));
//           if (maybeIncomingCalls) {
//             hits++;
//             item.incomingCalls = maybeIncomingCalls;
//             return;
//           } else {
//             misses++;
//           }

//           // console.log(`incomingCalls(${item.name})`);
//           const incomingCallsResult = await lspClient!.incomingCalls({
//             item,
//           });

//           if (!incomingCallsResult) {
//             return;
//           }

//           for (const incomingCall of incomingCallsResult) {
//             if (incomingCall.from.uri.endsWith("_test.go")) {
//               continue;
//             }

//             const callNode = {
//               ...incomingCall.from,
//               incomingCalls: [],
//             } as RecursiveCallHierarchyItem;

//             item.incomingCalls.push({
//               from: callNode,
//               fromRanges: incomingCall.fromRanges,
//             });
//             await buildCallHierarchy(callNode, log); // Recurse into the next level
//           }

//           nodesAlreadyVisited.set(nodeToKey(item), item.incomingCalls);
//         };

//         await buildCallHierarchy(startNode, false);
//         // console.log(
//         //   `done building "${startNodeKey}" in ${
//         //     (new Date().valueOf() - startTime.valueOf()) / 1000
//         //   }ms, ${hits} hits, ${misses} misses`
//         // );
//         hits = 0;
//         misses = 0;

//         // Function is not called from anywhere, skip it
//         if (startNode.incomingCalls.length === 0) {
//           continue;
//         }
//         console.log("Herrloooo");
//         // Generate Graphviz content for the function and store it in the map
//         const graphvizContent = generateGraphvizDOT(startNode);
//         graphvizMap.set(startNodeKey, graphvizContent);
//         console.log("Generated GraphvizDot");
//         // Build paths to bottom from root for code lenses
//         const codeLensesForFunction = [] as vscode.CodeLens[];
//         const stack = [{ node: startNode, path: "" }];
//         while (stack.length > 0) {
//           const { node, path } = stack.pop()!;

//           // If node is not called from anywhere, it's the root,
//           // turn it into a code lens
//           if (node.incomingCalls.length === 0) {
//             codeLensesForFunction.push(
//               new vscode.CodeLens(range, {
//                 title: node.name + path,
//                 command: "codeLineage.showCallGraph",
//                 arguments: [startNodeKey],
//               })
//             );
//           }

//           for (const incomingCall of node.incomingCalls) {
//             for (const fromRange of incomingCall.fromRanges) {
//               const lineOffset =
//                 fromRange.start.line - incomingCall.from.range.start.line;

//               stack.push({
//                 node: incomingCall.from,
//                 path: `.${lineOffset}${path}`,
//               });
//             }
//           }
//         }

//         if (codeLensesForFunction.length > 5) {
//           const excessCount = codeLensesForFunction.length - 5;
//           codeLensesForFunction.splice(5, excessCount);
//           codeLensesForFunction.push(
//             new vscode.CodeLens(range, {
//               title: `... and ${excessCount} more ...`,
//               command: "codeLineage.showCallGraph",
//               arguments: [startNodeKey],
//             })
//           );
//         }

//         for (const codeLens of codeLensesForFunction) {
//           codeLenses.push(codeLens);
//         }
//       }
//     }

//     return codeLenses;
//   }
// }
