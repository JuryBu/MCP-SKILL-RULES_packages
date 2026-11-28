import { normalizeBoardAddress } from "./conversation-address-book.mjs";
import { assertExactKeys, CoreError, normalizeIdentity } from "./contracts.mjs";

export const boardOperations = Object.freeze({
  create: { required: ["title"], optional: ["settings"], targeted: false },
  list: { required: [], optional: ["limit", "cursor"], targeted: false },
  subscribe: { required: [], optional: [] },
  unsubscribe: { required: [], optional: [] },
  invite: { required: ["members"], optional: [] },
  post: { required: [], optional: ["body", "mentions", "files", "sync_machines", "client_post_id"] },
  read: { required: [], optional: ["after_seq", "seq", "limit", "max_total_chars", "author_keys"] },
  set_subscription: { required: [], optional: ["delivery_mode", "filter_mode", "filter_targets"] },
  query_members: { required: [], optional: ["members"] },
  update_settings: { required: ["settings"], optional: [] },
  dissolve: { required: [], optional: [] },
  restore: { required: [], optional: [] },
  delete_archived: { required: ["expected_archive_version"], optional: ["expected_state_version"] },
});

export const LOCAL_MODEL_HOSTS = Object.freeze(new Set(["codex", "antigravity", "windsurf"]));

function validConcretePart(part) {
  return typeof part === "string" && part.length > 0 && part !== "*" && part === part.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(part);
}

function validLocalScope(scope, machineId) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) || typeof machineId !== "string" || !machineId) return false;
  return ["machine_id", "host", "surface"].every(key => validConcretePart(scope[key])) &&
    scope.machine_id === machineId && LOCAL_MODEL_HOSTS.has(scope.host);
}

function isAgentOnlyOrigins(principal) {
  return principal.origin_kinds === undefined || (Array.isArray(principal.origin_kinds) && principal.origin_kinds.length > 0 &&
    principal.origin_kinds.every(kind => kind === "agent_message"));
}

export function isLocalSharedHostPrincipal(principal, machineId) {
  if (!principal || principal.address_book_identity_bound === false || principal.channel_component != null) return false;
  const scope = principal.caller_scope;
  if (!validLocalScope(scope, machineId)) return false;
  if (!isAgentOnlyOrigins(principal)) return false;
  const identity = principal.identity;
  if (!identity || typeof identity !== "object") return false;
  return identity.machine_id === scope.machine_id && identity.host === scope.host && identity.surface === scope.surface;
}

export function isLocalPersonalPrincipal(principal, machineId) {
  if (!principal || typeof machineId !== "string" || !machineId) return false;
  if (principal.address_book_identity_bound === true && principal.caller_scope == null) {
    return principal.identity?.machine_id === machineId;
  }
  return isLocalSharedHostPrincipal(principal, machineId);
}

export function isAuthorizedBoardPrincipal(principal, machineId) {
  if (!principal || typeof machineId !== "string" || !machineId) return false;
  if (isLocalSharedHostPrincipal(principal, machineId)) {
    return principal.identity?.conversation_id === "*" || validConcretePart(principal.identity?.conversation_id);
  }
  return isLocalBoardCaller(principal, machineId);
}

export function isLocalBoardCaller(principal, machineId) {
  if (!isLocalPersonalPrincipal(principal, machineId)) return false;
  return ["machine_id", "host", "surface", "conversation_id"].every(key => validConcretePart(principal.identity?.[key]));
}

export function restrictBoardRelayDispatcher(dispatcher, peerMachines, capabilitiesFor) {
  if (!dispatcher || peerMachines.length === 0) return undefined;
  const allowed = new Set(peerMachines);
  return Object.freeze({
    registerOpHandler(operation, handler) {
      return dispatcher.registerOpHandler(operation, context => {
        const machine = context.remotePrincipal?.from_machine;
        if (!allowed.has(machine)) return { handled: false, status: "rejected", code: "forbidden" };
        if (context.staged_files?.length && capabilitiesFor(machine)?.allow_file_bundle !== true) {
          return { handled: false, status: "rejected", code: "relay_file_route_denied" };
        }
        return handler(context);
      });
    },
    async dispatchCustomOp(request) {
      if (!allowed.has(request.targetMachine)) throw new CoreError("forbidden", "该机器未获准同步交流板");
      if (request.attachments?.length && capabilitiesFor(request.targetMachine)?.allow_file_bundle !== true) {
        throw new CoreError("relay_file_route_denied", "该机器未获准同步交流板附件");
      }
      return dispatcher.dispatchCustomOp(request);
    },
  });
}

export function normalizeBoardInvocation(input, principal, addressBook, machineId) {
  const operation = typeof input?.action === "string" && Object.hasOwn(boardOperations, input.action) ? boardOperations[input.action] : null;
  if (!operation) throw new CoreError("invalid_input", "交流板操作无效");
  const targeted = operation.targeted !== false;
  const fields = [...operation.required, ...operation.optional];
  assertExactKeys(input, ["caller", "action", ...(targeted ? ["board"] : []), ...fields], "交流板");
  if ((targeted && input.board === undefined) || operation.required.some(field => input[field] === undefined)) {
    throw new CoreError("invalid_input", "缺少该交流板操作的必填参数");
  }
  let board;
  if (targeted) {
    if (input.board && typeof input.board === "object" && Object.hasOwn(input.board, "contact")) {
      assertExactKeys(input.board, ["contact"], "交流板代号");
      board = addressBook.resolveBoard(principal, input.board.contact);
    } else {
      board = normalizeBoardAddress(input.board, machineId);
    }
  }
  const params = Object.fromEntries(fields.filter(field => input[field] !== undefined).map(field => [field, input[field]]));
  return {
    action: input.action, actorIdentity: Object.freeze(normalizeIdentity(principal.identity)),
    ...(board ? { board: Object.freeze(board) } : {}), params,
  };
}
