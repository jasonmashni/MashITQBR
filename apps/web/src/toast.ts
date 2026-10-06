import { notifications } from '@mantine/notifications';

/** Toast for a failed action: the error's message, or "Unknown error". Uses the semantic "act" red. */
export function toastError(title: string, e: unknown): void {
  notifications.show({ color: 'act', title, message: e instanceof Error ? e.message : 'Unknown error' });
}

/** Toast confirming an action went through. Uses the semantic "good" teal. */
export function toastOk(message: string): void {
  notifications.show({ color: 'good', message });
}
