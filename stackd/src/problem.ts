import type { FastifyReply } from "fastify";

/** RFC 9457 problem+json error with a stable machine-readable `code`. */
export function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  detail?: string,
) {
  return reply
    .code(status)
    .header("content-type", "application/problem+json")
    .send({ type: `about:blank#${code}`, title, status, code, ...(detail ? { detail } : {}) });
}
