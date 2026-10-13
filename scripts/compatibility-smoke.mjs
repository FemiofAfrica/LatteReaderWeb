// CDP pauses and removes the Map APIs in every worker realm before module startup.
// Page network interception alone does not reach nested worker scripts.
process.env.LATTE_TEST_NO_MAP = '1'
process.env.LATTE_READER_URL ??= 'http://127.0.0.1:4176/'
await import('./worker-audit.mjs')
