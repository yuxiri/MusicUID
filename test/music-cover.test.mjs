import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'
const file = new URL('../MusicUID.js', import.meta.url)
const source = fs.readFileSync(file, 'utf8')
const code = source.slice(source.indexOf('function rememberCover('), source.indexOf('async function inlineCardCovers('))
function harness(fetch) {
  const scope = { fetch, Buffer, AbortSignal, COVER_CACHE_TTL: 1800000, COVER_CACHE_NEGATIVE_TTL: 60000,
    COVER_CACHE_MAX: 100, COVER_CACHE_MAX_BYTES: 307200, coverCache: new Map(), coverInFlight: new Map() }
  vm.runInNewContext(code + '\nglobalThis.run = getCoverDataUrl', scope)
  return scope
}
function imageStream({ length = 4, declared, type = 'image/png', status = 200, fail = false } = {}) {
  const state = { pulled: 0, cancelled: false }
  let sent = 0
  const body = new ReadableStream({
    pull(controller) {
      state.pulled++
      if (fail) { controller.error(new Error('stream interrupted')); return }
      if (sent >= length) { controller.close(); return }
      const size = Math.min(64 * 1024, length - sent)
      sent += size
      controller.enqueue(new Uint8Array(size))
    },
    cancel() { state.cancelled = true }
  }, { highWaterMark: 0 })
  const headers = { 'content-type': type }
  if (declared !== undefined) headers['content-length'] = String(declared)
  return { response: new Response(body, { status, headers }), state }
}
test('normal image retains base64 format and cache', async () => {
  let calls = 0
  const h = harness(async () => { calls++; return imageStream().response })
  assert.equal(await h.run('https://test/a'), 'data:image/png;base64,AAAAAA==')
  assert.equal(await h.run('https://test/a'), 'data:image/png;base64,AAAAAA==')
  assert.equal(calls, 1)
})
test('announced oversized body is cancelled before reading', async () => {
  const { response, state } = imageStream({ length: 3 * 1024 * 1024, declared: 3 * 1024 * 1024 })
  assert.equal(await harness(async () => response).run('https://test/b'), '')
  assert.equal(state.pulled, 0)
  assert.equal(state.cancelled, true)
})
test('chunked oversized body is stopped at limit and negatively cached', async () => {
  const { response, state } = imageStream({ length: 8 * 1024 * 1024 })
  let calls = 0
  const h = harness(async () => { calls++; return response })
  assert.equal(await h.run('https://test/c'), '')
  assert.equal(await h.run('https://test/c'), '')
  assert.equal(calls, 1)
  assert.ok(state.pulled <= 33, `read ${state.pulled} chunks`)
  assert.equal(state.cancelled, true)
  assert.equal(h.coverInFlight.size, 0)
})
test('exact 2 MiB remains supported without caching a large image', async () => {
  const h = harness(async () => imageStream({ length: 2 * 1024 * 1024 }).response)
  assert.ok((await h.run('https://test/d')).startsWith('data:image/png;base64,'))
  assert.equal(h.coverCache.size, 0)
})
for (const options of [{ type: 'text/html' }, { status: 503 }]) {
  test(`invalid response cancels body: ${JSON.stringify(options)}`, async () => {
    const { response, state } = imageStream(options)
    assert.equal(await harness(async () => response).run('https://test/e'), '')
    assert.equal(state.cancelled, true)
    assert.equal(state.pulled, 0)
  })
}
test('concurrent callers share the request', async () => {
  let calls = 0
  const h = harness(async () => { calls++; return imageStream().response })
  const values = await Promise.all([h.run('https://test/f'), h.run('https://test/f')])
  assert.equal(values[0], values[1]); assert.equal(calls, 1); assert.equal(h.coverInFlight.size, 0)
})
test('body failure falls back and releases stream reader', async () => {
  const { response } = imageStream({ fail: true })
  const h = harness(async () => response)
  assert.equal(await h.run('https://test/g'), '')
  assert.equal(response.body.locked, false)
  assert.equal(h.coverInFlight.size, 0)
})