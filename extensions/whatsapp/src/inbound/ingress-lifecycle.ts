import type { WhatsAppIngressLifecycle } from "./durable-receive.js";

// The WhatsApp plugin can be evaluated more than once by runtime/JIT module
// boundaries. Keep lifecycle metadata visible across those module instances.
const ingressLifecycleKey = Symbol.for("openclaw.whatsappIngressLifecycle");

type WhatsAppIngressLifecycleCarrier = {
  [ingressLifecycleKey]?: WhatsAppIngressLifecycle;
};

export function attachWhatsAppIngressLifecycle<T extends object>(
  message: T,
  lifecycle: WhatsAppIngressLifecycle | undefined,
): T {
  if (lifecycle) {
    (message as WhatsAppIngressLifecycleCarrier)[ingressLifecycleKey] = lifecycle;
  }
  return message;
}

export function resolveWhatsAppIngressLifecycle(
  message: object,
): WhatsAppIngressLifecycle | undefined {
  return (message as WhatsAppIngressLifecycleCarrier)[ingressLifecycleKey];
}
