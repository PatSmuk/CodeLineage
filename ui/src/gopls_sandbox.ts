import { spawn } from "child_process";
import { relative } from "path";
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

const lspProcess = spawn("gopls", {
  shell: true,
  stdio: "pipe",
});
const killLsp = () => void lspProcess.kill();

const endpoint = new JSONRPCEndpoint(lspProcess.stdin, lspProcess.stdout);
const client = new LspClient(endpoint);
const ROOT_PATH = "/Users/love.sharma/Desktop/WIP/billing/internal/auditlog";
const TEST_FILE_URI = `file://${ROOT_PATH}/builder_bid.go`;

// Data structures for memoization and storage
const graphvizMap: Record<string, string> = {};
const callHierarchyCache: Map<string, RecursiveCallHierarchyItem> = new Map();

// Function to build the call hierarchy recursively with memoization
const buildCallHierarchy = async (
  item: RecursiveCallHierarchyItem,
  client: LspClient
): Promise<RecursiveCallHierarchyItem> => {
  const nodeId = `${item.name}_${item.uri}`;
  if (callHierarchyCache.has(nodeId)) {
    return callHierarchyCache.get(nodeId)!; // Return cached node
  }

  const incomingCallsResult = await client.incomingCalls({ item });
  if (!incomingCallsResult) {
    callHierarchyCache.set(nodeId, item); // Cache even if no incoming calls
    return item;
  }

  for (const incomingCall of incomingCallsResult) {
    if (incomingCall.from.uri.endsWith("_test.go")) continue;

    const callNode = {
      ...incomingCall.from,
      incomingCalls: [],
    } as RecursiveCallHierarchyItem;

    item.incomingCalls.push({
      from: await buildCallHierarchy(callNode, client), // Recurse and cache
      fromRanges: incomingCall.fromRanges,
    });
  }

  callHierarchyCache.set(nodeId, item); // Cache the processed node
  return item;
};

// Function to generate Graphviz DOT representation
const generateGraphvizDOT = (root: RecursiveCallHierarchyItem): string => {
  const edges = new Set<string>();
  const nodes = new Set<string>();

  const relativePath = (uri: string) =>
    relative(ROOT_PATH, decodeURIComponent(new URL(uri).pathname));

  const traverse = (node: RecursiveCallHierarchyItem) => {
    const nodeId = `${node.name}_${relativePath(node.uri)}`;
    nodes.add(`"${nodeId}" [label="${node.name}\\n(${relativePath(node.uri)})"];`);
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

  return `digraph CallHierarchy {
  rankdir=TB; // Top-to-bottom layout
  node [shape=box, fontname="Arial"];
  ${Array.from(nodes).join("\n  ")}
  ${Array.from(edges).join("\n  ")}
}`;
};

(async () => {
  await client.initialize({
    processId: process.pid,
    capabilities: {},
    clientInfo: {
      name: "gopls_test",
      version: "0.0.0",
    },
    rootUri: `file://${ROOT_PATH}`,
  });

  console.log("initialize response:");
  await client.initialized();

  const results = (await client.documentSymbol({
    textDocument: {
      uri: TEST_FILE_URI,
    },
  })) as SymbolInformation[] | null;

  if (!results) {
    await client.shutdown();
    return;
  }

  for (const { location, name, kind } of results) {
    if (kind === SymbolKind.Function) {
      const prepareResult = await client.prepareCallHierarchy({
        textDocument: {
          uri: TEST_FILE_URI,
        },
        position: {
          line: location.range.start.line,
          character: location.range.start.character + 5,
        },
      });

      if (!prepareResult) continue;

      const rootItem = prepareResult[0];
      const rootNode = {
        ...rootItem,
        incomingCalls: [],
      } as RecursiveCallHierarchyItem;

      await buildCallHierarchy(rootNode, client); // Build hierarchy with memoization

      // Generate Graphviz DOT for the function and store in map
      graphvizMap[name] = generateGraphvizDOT(rootNode);
    }
  }

  await client.shutdown();

  console.log(`Total Graphviz Representations Created: ${Object.keys(graphvizMap).length}`);
  console.log("Graphviz representations:");
  for (const [functionName, graphviz] of Object.entries(graphvizMap)) {
    console.log(`Function: ${functionName}`);
    console.log(graphviz);
    console.log("\n-------------------------------------------\n");
  }
})().then(killLsp, killLsp);
