/** Browser and Mac must both retain the subscription for notifications to work. */
export async function notificationsEnabled(serverOn: boolean, permission: NotificationPermission,
  manager: Pick<PushManager, 'getSubscription'>): Promise<boolean> {
  return serverOn && permission === 'granted' && Boolean(await manager.getSubscription())
}

/** Once the browser stops delivery, a failed Mac request must not turn the bell back on. */
export async function disableNotifications(manager: Pick<PushManager, 'getSubscription'>,
  removeFromMac: () => Promise<unknown>, onDisabled: () => void): Promise<void> {
  await (await manager.getSubscription())?.unsubscribe()
  onDisabled()
  await removeFromMac()
}
