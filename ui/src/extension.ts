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

interface LineageCodeLens extends vscode.CodeLens {
  startNode: RecursiveCallHierarchyItem;
}

class LineageCodeLensProvider
  implements vscode.CodeLensProvider<LineageCodeLens>
{
  nodesAlreadyVisited = new Map<string, RecursiveCallHierarchyIncomingCall[]>();
  hits = 0;
  misses = 0;
  constructor() {}

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<LineageCodeLens[]> {
    if (!lspClient) {
      return [];
    }

    console.log("provideCodeLenses called with " + document.uri.toString());

    const results = (await lspClient.documentSymbol({
      textDocument: {
        uri: document.uri.toString(),
      },
    })) as SymbolInformation[] | null;

    if (!results || token.isCancellationRequested) {
      return [];
    }

    const codeLenses: LineageCodeLens[] = [];

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

        const lens = new vscode.CodeLens(range) as LineageCodeLens;
        lens.startNode = startNode;
        codeLenses.push(lens);
      }
    }

    return codeLenses;
  }

  async resolveCodeLens(
    codeLens: LineageCodeLens,
    token: vscode.CancellationToken
  ): Promise<LineageCodeLens | null> {
    const startNode = codeLens.startNode;
    console.log(`resolving "${codeLens.startNode.name}"`);
    const startNodeKey = nodeToKey(startNode);

    // Recursively fetch the incoming calls and build the tree
    const buildCallHierarchy = async (
      item: RecursiveCallHierarchyItem,
      log: boolean
    ) => {
      if (token.isCancellationRequested) {
        return;
      }

      const maybeIncomingCalls = this.nodesAlreadyVisited.get(nodeToKey(item));
      if (maybeIncomingCalls) {
        this.hits++;
        item.incomingCalls = maybeIncomingCalls;
        return;
      } else {
        this.misses++;
      }

      console.log(`incomingCalls(${item.name})`);
      const incomingCallsResult = await lspClient!.incomingCalls({
        item,
      });

      console.log("result: " + incomingCallsResult);
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

      this.nodesAlreadyVisited.set(nodeToKey(item), item.incomingCalls);
    };

    await buildCallHierarchy(startNode, false);

    // Function is not called from anywhere, skip it
    if (startNode.incomingCalls.length === 0) {
      return null;
    }

    // Generate Graphviz content for the function and store it in the map
    const graphvizContent = generateGraphvizDOT(startNode);
    graphvizMap.set(startNodeKey, graphvizContent);

    // Build paths to bottom from root for code lenses
    const pathsForFunction = [] as string[];
    const stack = [{ node: startNode, path: "" }];
    while (stack.length > 0) {
      const { node, path } = stack.pop()!;

      // If node is not called from anywhere, it's the root,
      // turn it into a code lens
      if (node.incomingCalls.length === 0) {
        pathsForFunction.push(node.name + path);
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

    let title = pathsForFunction.join(", ");
    let excess = 0;
    while (title.length > 80 && pathsForFunction.length > 1) {
      pathsForFunction.pop();
      excess++;
      title = pathsForFunction.join(", ");
    }
    if (excess > 0) {
      title += `, and ${excess} more`;
    }

    codeLens.command = {
      title,
      command: "codeLineage.showCallGraph",
      arguments: [startNodeKey],
    };

    return codeLens;
  }
}
