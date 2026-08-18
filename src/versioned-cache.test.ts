import test from 'node:test'
import assert from 'node:assert/strict'
import { VersionedCache } from './versioned-cache.js'

test('reuses one value per document version and invalidates on removal', () => {
  const cache = new VersionedCache<object>()
  let calls = 0
  const create = () => ({ call: ++calls })
  assert.equal(cache.getOrCreate('u', 1, create), cache.getOrCreate('u', 1, create))
  assert.notEqual(cache.getOrCreate('u', 2, create), cache.getOrCreate('u', 1, create))
  cache.remove('u')
  assert.equal(cache.get('u', 1), undefined)
})
