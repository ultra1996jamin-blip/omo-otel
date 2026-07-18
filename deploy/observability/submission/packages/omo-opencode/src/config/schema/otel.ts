import { z } from "zod"

export const OtelConfigSchema = z.object({
  enabled: z.boolean().optional(),
  exporter_type: z.enum(["otlp", "jaeger", "file", "console"]).optional(),
  exporters: z
    .object({
      otlp: z.string().optional(),
    })
    .optional(),
  sampling_rate: z.number().min(0).max(1).optional(),
})

export type OtelConfig = z.infer<typeof OtelConfigSchema>
