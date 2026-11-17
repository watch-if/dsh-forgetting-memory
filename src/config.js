import z from '@deepseek-ai/schemastery'

/** DSH settings shown on the plugin's configuration page. Times are expressed in minutes/days for readability. */
export const Config = z.object({
  ownerId: z.string().default('owner:unconfigured'),
  sleepAuthorizedIdsJson: z.string().default('[]').volatile(),
  dataDir: z.string().default(''),
  intervalMinutes: z.number().step(1).min(1).max(120).default(10).volatile(),
  quietGapEnabled: z.boolean().default(false).volatile(),
  quietGapMinutes: z.number().step(1).min(1).max(60).default(3).volatile(),
  maxSegmentMinutes: z.number().step(1).min(5).max(180).default(30).volatile(),
  offlineTtlMinutes: z.number().step(1).min(1).max(1440).default(30).volatile(),
  halfLifeDays: z.number().step(1).min(1).max(3650).default(7).volatile(),
  relationHalfLifeDays: z.number().step(1).min(1).max(3650).default(30).volatile(),
  forgetThreshold: z.number().min(0).max(1).default(0.15).volatile(),
  cornerThreshold: z.number().min(0).max(1).default(0.32).volatile(),
  diaryThreshold: z.number().min(0).max(1).default(0.55).volatile(),
  relationCapacity: z.number().step(1).min(0).max(1000).default(12).volatile(),
  memoryTokenBudget: z.number().step(50).min(100).max(10000).default(800).volatile(),
  maxRecallChars: z.number().step(100).min(100).max(30000).default(4000).volatile(),
  maxDiaryChars: z.number().step(100).min(100).max(50000).default(4000).volatile(),
  archiveSummaryChars: z.number().step(10).min(32).max(500).default(180).volatile(),
  maxActivePerScope: z.number().step(100).min(100).max(100000).default(1000).volatile(),
  memeLexiconJson: z.string().default('{}').volatile(),
})
