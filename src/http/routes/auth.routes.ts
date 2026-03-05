import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthService } from "../../modules/auth/auth.service";

const continueSchema = z.object({
  idToken: z.string().min(1),
  idempotencyKey: z.string().uuid().optional(),
});

export async function registerAuthRoutes(server: FastifyInstance, deps: { authService: AuthService }): Promise<void> {
  server.post("/v1/auth/google/continue", async (request, reply) => {
    const body = continueSchema.parse(request.body);
    const result = await deps.authService.continueWithGoogle(body);

    return reply.status(200).send({
      data: result,
    });
  });
}
