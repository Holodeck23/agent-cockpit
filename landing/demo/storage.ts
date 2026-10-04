// Keep real component drafts isolated from both the website and an installed app.
const values = new Map<string, string>([['cockpit:theme', 'light']])
export const demoStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, String(value)) },
  removeItem: (key: string) => { values.delete(key) },
  clear: () => { values.clear(); values.set('cockpit:theme', 'light') },
  key: (index: number) => [...values.keys()][index] ?? null,
  get length() { return values.size },
}
