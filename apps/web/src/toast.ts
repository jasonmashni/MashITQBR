import { notifications } from '@mantine/notifications';

/** Red toast for a failed action; the error's message, or "Unknown error". */
export function toastError(title: string, e: unknown): void {
  notifications.show({ color: 'red', title, message: e instanceof Error ? e.message : 'Unknown error' });
}

/** Teal toast confirming an action went through. */
export function toastOk(message: string): void {
  notifications.show({ color: 'teal', message });
}
