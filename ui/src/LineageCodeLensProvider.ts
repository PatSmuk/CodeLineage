import { relative } from "path";
import * as vscode from "vscode";
import {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
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

interface LineageCodeLens extends vscode.CodeLens {
  startNode: RecursiveCallHierarchyItem;
}

// Function to generate Graphviz DOT representation
function generateGraphvizDOT(
  root: RecursiveCallHierarchyItem,
  rootPath: string
): string {
  const edges = new Set<string>();
  const nodes = new Set<string>();

  const relativePath = (uri: string) =>
    relative(rootPath, decodeURIComponent(new URL(uri).pathname));

  const traverse = (
    node: RecursiveCallHierarchyItem,
    fromRange: RecursiveCallHierarchyIncomingCall["fromRanges"][0] | null
  ) => {
    let nodeId = `${node.name}_${relativePath(node.uri)}`;
    let label = `${node.name}\\n(${relativePath(node.uri)}${
      fromRange ? ":" + fromRange.start.line : ""
    })`;
    if (fromRange) {
      nodeId += `_${fromRange.start.line}`;
    }
    nodes.add(`"${nodeId}" [label="${label}"];`);

    for (const incomingCall of node.incomingCalls) {
      for (const fromRange of incomingCall.fromRanges) {
        const childNodeId = `${incomingCall.from.name}_${relativePath(
          incomingCall.from.uri
        )}_${fromRange.start.line}`;
        const edge = `"${childNodeId}" -> "${nodeId}";`;
        if (!edges.has(edge)) {
          edges.add(edge);
        }
        traverse(incomingCall.from, fromRange); // Recurse into children
      }
    }
  };

  traverse(root, null);

  return `digraph ${root.name}CallHierarchy {
    rankdir=TB; // Top-to-bottom layout
    node [shape=box, fontname="Arial"];
    ${Array.from(nodes).join("\n  ")}
    ${Array.from(edges).join("\n  ")}
  }`;
}

export class LineageCodeLensProvider
  implements vscode.CodeLensProvider<LineageCodeLens>
{
  nodesAlreadyVisited = new Map<string, RecursiveCallHierarchyIncomingCall[]>();
  hits = 0;
  misses = 0;
  constructor(
    private lspClient: LspClient,
    private graphvizMap: Map<string, string>,
    private rootPath: string
  ) {}

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<LineageCodeLens[]> {
    //console.log("provideCodeLenses called with " + document.uri.toString());

    const results = (await this.lspClient.documentSymbol({
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

        const prepareResult = await this.lspClient.prepareCallHierarchy({
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
    //console.log(`resolving "${codeLens.startNode.name}"`);
    const startNodeKey = nodeToKey(startNode);

    // Recursively fetch the incoming calls and build the tree
    const buildCallHierarchy = async (item: RecursiveCallHierarchyItem) => {
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

      const incomingCallsResult = await this.lspClient!.incomingCalls({
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

      this.nodesAlreadyVisited.set(nodeToKey(item), item.incomingCalls);
    };

    await buildCallHierarchy(startNode);

    // Function is not called from anywhere, skip it
    if (startNode.incomingCalls.length === 0) {
      return null;
    }

    // Generate Graphviz content for the function and store it in the map
    const graphvizContent = generateGraphvizDOT(startNode, this.rootPath);
    this.graphvizMap.set(startNodeKey, graphvizContent);

    // Build paths to bottom from root for code lenses
    let pathsForFunction = [] as string[];
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

    // Trim each path to max 5 segments.
    pathsForFunction = pathsForFunction.map((path) => {
      const segments = path.split(".");
      if (segments.length <= 5) {
        return path;
      }
      return segments.slice(5).join(".") + "...";
    });

    // Trim the amount of paths to fit in a reasonable amount of space.
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