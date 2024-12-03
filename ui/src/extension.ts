import { instance } from "@viz-js/viz";
import { spawn } from "child_process";
import { JSDOM } from "jsdom";
import { relative } from "path";
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

function nodeToKey(item: RecursiveCallHierarchyItem) {
  return `${item.uri.toString()}::${item.name}`;
}

let rootPath: string = "";
global.DOMParser = new JSDOM().window.DOMParser;

// Flag to track processing state
let isProcessing = false;
let statusBarItem: vscode.StatusBarItem | null = null;

function setProcessingState(state: boolean) {
  isProcessing = state;
  if (statusBarItem) {
    if (state) {
      statusBarItem.text = "Processing..."; // Set status bar text to indicate processing
      statusBarItem.show();
    } else {
      statusBarItem.text = "Idle"; // Reset to Idle when processing ends
      statusBarItem.show();
    }
  }
}
// Function to generate Graphviz DOT representation
function generateGraphvizDOT(root: RecursiveCallHierarchyItem): string {
  const edges = new Set<string>();
  const nodes = new Set<string>();

  const relativePath = (uri: string) =>
    relative(rootPath, decodeURIComponent(new URL(uri).pathname));

  const traverse = (node: RecursiveCallHierarchyItem) => {
    const nodeId = `${node.name}_${relativePath(node.uri)}`;
    nodes.add(
      `"${nodeId}" [label="${node.name}\\n(${relativePath(node.uri)})"];`
    );
    for (const incomingCall of node.incomingCalls) {
      const childNodeId = `${incomingCall.from.name}_${relativePath(
        incomingCall.from.uri
      )}`;
      const edge = `"${childNodeId}" -> "${nodeId}";`;
      if (!edges.has(edge)) {
        edges.add(edge);
      }
      traverse(incomingCall.from); // Recurse into children
    }
  };

  traverse(root);

  return `digraph ${root.name}CallHierarchy {
  rankdir=TB; // Top-to-bottom layout
  node [shape=box, fontname="Arial"];
  ${Array.from(nodes).join("\n  ")}
  ${Array.from(edges).join("\n  ")}
}`;
}

let lspClient: LspClient | null = null;
const graphvizMap = new Map<string, string>();

export async function activate(context: vscode.ExtensionContext) {
  // Create a status bar item to show processing state
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  context.subscriptions.push(statusBarItem);
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
    new LineageCodeLensProvider()
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
        const panel = vscode.window.createWebviewPanel(
          "lineageDetails",
          "Lineage",
          vscode.ViewColumn.Beside,
          {}
        );
        panel.webview.html = `
            <div class="lineage-box">
              ${svgContent.outerHTML}
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

    console.log("provideCodeLenses called with " + document.uri.toString());
    const startTime = new Date();
    setProcessingState(true)
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
    let hits = 0;
    let misses = 0;

    for (const { location, kind, name } of results) {
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
        const startNodeKey = nodeToKey(startNode);

        // Recursively fetch the incoming calls and build the tree
        const buildCallHierarchy = async (
          item: RecursiveCallHierarchyItem,
          log: boolean
        ) => {
          if (token.isCancellationRequested) {
            return;
          }

          const maybeIncomingCalls = nodesAlreadyVisited.get(nodeToKey(item));
          if (maybeIncomingCalls) {
            hits++;
            item.incomingCalls = maybeIncomingCalls;
            return;
          } else {
            misses++;
          }

          // console.log(`incomingCalls(${item.name})`);
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
            await buildCallHierarchy(callNode, log); // Recurse into the next level
          }

          nodesAlreadyVisited.set(nodeToKey(item), item.incomingCalls);
        };

        await buildCallHierarchy(startNode, false);
        // console.log(
        //   `done building "${startNodeKey}" in ${
        //     (new Date().valueOf() - startTime.valueOf()) / 1000
        //   }ms, ${hits} hits, ${misses} misses`
        // );
        hits = 0;
        misses = 0;

        // Function is not called from anywhere, skip it
        if (startNode.incomingCalls.length === 0) {
          continue;
        }

        // Generate Graphviz content for the function and store it in the map
        const graphvizContent = generateGraphvizDOT(startNode);
        graphvizMap.set(startNodeKey, graphvizContent);

        // Build paths to bottom from root for code lenses
        const codeLensesForFunction = [] as vscode.CodeLens[];
        const stack = [{ node: startNode, path: "" }];
        while (stack.length > 0) {
          const { node, path } = stack.pop()!;

          // If node is not called from anywhere, it's the root,
          // turn it into a code lens
          if (node.incomingCalls.length === 0) {
            codeLensesForFunction.push(
              new vscode.CodeLens(range, {
                title: node.name + path,
                command: "codeLineage.showCallGraph",
                arguments: [startNodeKey],
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

        if (codeLensesForFunction.length > 5) {
          const excessCount = codeLensesForFunction.length - 5;
          codeLensesForFunction.splice(5, excessCount);
          codeLensesForFunction.push(
            new vscode.CodeLens(range, {
              title: `... and ${excessCount} more ...`,
              command: "codeLineage.showCallGraph",
              arguments: [startNodeKey],
            })
          );
        }

        for (const codeLens of codeLensesForFunction) {
          codeLenses.push(codeLens);
        }
      }
    }
    setProcessingState(false)
    return codeLenses;
  }
}
