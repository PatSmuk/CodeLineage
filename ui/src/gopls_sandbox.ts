import { spawn } from "child_process";
import {
  JSONRPCEndpoint,
  LspClient,
  SymbolInformation,
  SymbolKind,
} from "./ts-lsp-client";

// Function to represent the tree structure
class CallTreeNode {
  name: string;
  children: CallTreeNode[];

  constructor(name: string) {
    this.name = name;
    this.children = [];
  }

  addChild(child: CallTreeNode) {
    this.children.push(child);
  }

  // Method to print the tree in a human-readable way
  print(indent: string = "") {
    console.log(`${indent}${this.name}`);
    this.children.forEach((child) => child.print(indent + "  "));
  }
}

const lspProcess = spawn("gopls", {
  shell: true,
  stdio: "pipe",
});
const killLsp = () => void lspProcess.kill();

const endpoint = new JSONRPCEndpoint(lspProcess.stdin, lspProcess.stdout);
const client = new LspClient(endpoint);

const TEST_FILE_URI =
  "file:///Users/love.sharma/Desktop/WIP/billing/internal/auditlog/builder_bid.go";

(async () => {
  await client.initialize({
    processId: process.pid,
    capabilities: {},
    clientInfo: {
      name: "gopls_test",
      version: "0.0.0",
    },
    rootUri:
      "file:///Users/love.sharma/Desktop/WIP/billing/internal/auditlog",
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

      if (!prepareResult) {
        continue;
      }

      const rootItem = prepareResult[0];
      const rootNode = new CallTreeNode(name); // Start the tree with the root function

      // Recursively fetch the incoming calls and build the tree
      const buildCallHierarchy = async (item: any, parentNode: CallTreeNode) => {
        const incomingCallsResult = await client.incomingCalls({
          item,
        });

        if (!incomingCallsResult) {
          return;
        }

        for (const incomingCall of incomingCallsResult) {
          const callNode = new CallTreeNode(incomingCall.from.name);
          parentNode.addChild(callNode); // Add the child node
          await buildCallHierarchy(incomingCall.from, callNode); // Recurse into the next level
        }
      };

      await buildCallHierarchy(rootItem, rootNode);

      // Print the tree
      console.log(`Call hierarchy for function "${name}":`);
      rootNode.print();

      console.log("\n-------------------------------------------");
    }
  }

  await client.shutdown();
})().then(killLsp, killLsp);
