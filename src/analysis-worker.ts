// Worker entry: runs analyses off the server's event loop, one at a time, in
// the order the AnalysisRunner posts them.
import { parentPort } from 'node:worker_threads'
import { newAnalysisCaches, runAnalysisJob } from './analysis-job.js'
import type { WorkerRequest, WorkerResponse } from './analysis-runner.js'

const caches = newAnalysisCaches()

parentPort?.on('message', (message: WorkerRequest) => {
  if (message.type === 'invalidate') {
    caches.sources.invalidate(message.path)
    caches.parses.invalidate(message.path)
    return
  }
  let response: WorkerResponse
  try {
    response = { id: message.id, analysis: runAnalysisJob(message.job, caches) }
  } catch (error) {
    response = { id: message.id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }
  }
  parentPort!.postMessage(response)
})
