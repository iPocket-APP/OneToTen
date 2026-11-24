export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* Try the selection-based copy in browsers that deny clipboard access. */ }
  }
  const previousFocus = document.activeElement;
  const field = document.createElement('textarea');
  field.className = 'clipboard-copy';
  field.value = text;
  field.readOnly = true;
  document.body.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, field.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }
}
