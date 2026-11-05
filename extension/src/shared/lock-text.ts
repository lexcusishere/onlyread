// The lock's word (the popup's and the settings page's #lock): its first sentence as a bold title, the rest after it.
// Text nodes only: the words are our own, a refusal's included.
export function setLockText(el: HTMLElement, text: string): void {
  const cut = text.search(/\.\s/);
  if (cut < 0) { el.textContent = text; return; }
  const title = document.createElement('b');
  title.textContent = text.slice(0, cut + 1);
  el.replaceChildren(title, ` ${text.slice(cut + 2)}`); // the space keeps the words apart when read as text
}
