let pending = 0;

export async function enqueue(store: { get(k: string): Promise<number>; set(k: string, v: number): Promise<void> }) {
  const current = await store.get("pending");
  await store.set("pending", current + 1);
  pending = current + 1;
  return pending;
}
