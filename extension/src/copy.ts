/**
 * Copies text to the clipboard. Amplience's extension sandbox can block the Clipboard API, so this
 * falls back to copying from a hidden, selected textarea. Resolves false when neither works.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
    Object.assign(area.style, { position: 'fixed', top: '0', left: '0', opacity: '0' });
    document.body.append(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}
