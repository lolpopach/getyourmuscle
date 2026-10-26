import { describe, expect, it } from 'vitest'
import { serverHas } from './server-features.js'

// The Cloudflare Worker's API leaves out push, pairing and device codes, and closes sign-up after
// its owner. The screens hide those only on its explicit word, never on a missing config.
describe('serverHas', () => {
  it('hides a feature the server says it does not have', () => {
    const config = { invite_only: true, push: false, pairing: false, device_link: false, signup: false }
    for (const name of ['push', 'pairing', 'device_link', 'signup']) expect(serverHas(config, name)).toBe(false)
  })

  it('keeps everything on the full server, which names none of it', () => {
    const config = { invite_only: false, allow_guest: true, password_login: true }
    for (const name of ['push', 'pairing', 'device_link', 'signup']) expect(serverHas(config, name)).toBe(true)
  })

  it('keeps everything while the config has not arrived', () => {
    expect(serverHas(null, 'push')).toBe(true)
    expect(serverHas(undefined, 'signup')).toBe(true)
  })

  it('does not read other falsy values as a no', () => {
    for (const v of [0, '', null, undefined]) expect(serverHas({ push: v }, 'push')).toBe(true)
  })
})
