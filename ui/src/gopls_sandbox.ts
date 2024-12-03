import { spawn } from "child_process";
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

const TEST_FILE_URI =
  "file:///Users/pat.smuk/Code/gitlab.indexexchange.com/exchange-node/billing/internal/auditlog/builder_bid.go";

(async () => {
  await client.initialize({
    processId: process.pid,
    capabilities: {},
    clientInfo: {
      name: "gopls_test",
      version: "0.0.0",
    },
    rootUri:
      "file:///Users/pat.smuk/Code/gitlab.indexexchange.com/exchange-node/billing/internal/auditlog",
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
      const rootNode = {
        ...rootItem,
        incomingCalls: [],
      } as RecursiveCallHierarchyItem;

      // Recursively fetch the incoming calls and build the tree
      const buildCallHierarchy = async (item: RecursiveCallHierarchyItem) => {
        const incomingCallsResult = await client.incomingCalls({
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
      };

      await buildCallHierarchy(rootNode);

      // Print the tree
      console.log(`Call hierarchy for function "${name}":`);
      console.log(JSON.stringify(rootNode, null, 2));

      console.log("\n-------------------------------------------");
    }
  }

  await client.shutdown();
})().then(killLsp, killLsp);
