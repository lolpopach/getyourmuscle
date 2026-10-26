/**
 * Whether the server behind this app does something, given the public config from /api/config.
 *
 * The full Node server (api/server.js) does everything and names none of it. A smaller server
 * says what it leaves out with `<name>: false` — the Cloudflare Worker's API (cloudflare/api.js)
 * has no `push`, `pairing` or `device_link`, and sends `signup: false` once its owner has a
 * profile. Like guestAllowed, only an explicit false counts: a config that has not arrived, or
 * one that does not mention the feature, means it is there, so the Node server's screens stay
 * exactly as they were.
 *
 * @param {object|null|undefined} config Parsed /api/config body, or null.
 * @param {'push'|'pairing'|'device_link'|'signup'} name
 * @returns {boolean}
 */
export const serverHas = (config, name) => !(config && config[name] === false)
