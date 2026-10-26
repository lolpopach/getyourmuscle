// The one Durable Object that holds G-PLAN's data in its SQLite storage. A personal instance
// needs exactly one (idFromName('main')): every request for the API runs in it, one at a time,
// so a revision check and the write after it can never interleave (api/server.js relies on the
// same property of its single process).
import { DurableObject } from 'cloudflare:workers'
import { SCHEMA, createApi } from './api.js'

export class GymStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    const sql = ctx.storage.sql
    const db = { exec: (q, ...p) => sql.exec(q, ...p).toArray() }
    ctx.blockConcurrencyWhile(async () => {
      for (const s of SCHEMA) sql.exec(s)
      this.handle = createApi(db, env)
    })
  }

  async fetch(request) {
    return this.handle(request)
  }
}
