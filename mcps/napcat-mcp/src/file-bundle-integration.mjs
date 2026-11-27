import { createFileBundleRelayBinding } from "./file-bundle-relay-binding.mjs";
import { createFileBundleEndpoint, fileBundleTools } from "./file-bundle-endpoint.mjs";
import { openFileBundleControlConsumer } from "./file-bundle-consumer.mjs";

export async function openFileBundleIntegration({ enabled, authorizeInvocation, resolveAttachments, runtimeOptions, relay, now }) {
  if (enabled !== true) return null;
  const closing = new AbortController();
  const originalContext = Symbol("trusted connection context");
  const binding = createFileBundleRelayBinding(relay);
  const endpoint = await createFileBundleEndpoint({
    authorizeInvocation: async (tool, context) => !closing.signal.aborted
      && await authorizeInvocation(tool, context?.[originalContext]) === true && !closing.signal.aborted,
    resolveRoute: binding.resolveRoute, resolveAttachments, now,
    runtimeOptions: { ...runtimeOptions, control: binding.control, routeAuthorized: binding.routeAuthorized },
    openControlConsumer: ({ privateRoot, ingestControl }) => openFileBundleControlConsumer({
      privateRoot, ingestControl, now, decodeVerifiedEvent: binding.decodeVerifiedEvent,
      listScopes: relay.listScopes, readVerifiedPage: relay.readVerifiedPage,
    }),
  });
  return {
    async listTools(context) {
      const visible = [];
      for (const tool of fileBundleTools) {
        if (closing.signal.aborted) return [];
        if (await authorizeInvocation(tool.name, context) === true) visible.push(tool);
      }
      return closing.signal.aborted ? [] : visible;
    },
    async invoke(tool, input, context) {
      closing.signal.throwIfAborted();
      const session = new AbortController();
      const signals = [closing.signal, context?.signal].filter(Boolean);
      const listeners = signals.map((signal) => {
        const listener = () => session.abort(signal.reason);
        if (signal.aborted) listener();
        else signal.addEventListener("abort", listener, { once: true });
        return { signal, listener };
      });
      try {
        return await endpoint.invoke(tool, input, { ...context, [originalContext]: context, signal: session.signal });
      } finally {
        for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
      }
    },
    close() {
      closing.abort(Object.assign(new Error("本机文件包入口已停用，原账保留"), { code: "RELAY_FILE_INTEGRATION_DISABLED" }));
    },
  };
}
