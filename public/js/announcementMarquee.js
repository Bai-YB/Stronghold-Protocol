/** Fill a clipped ticker with identical copies and animate by exactly one measured copy width. */
export function mountAnnouncementMarquee(viewport, track, message, {
  durationProperty = '--ticker-duration', shiftProperty = '--ticker-shift',
} = {}) {
  if (!viewport || !track) return () => {};
  const first = document.createElement('span');
  first.textContent = String(message || '');
  track.replaceChildren(first);

  function update() {
    const distance = first.getBoundingClientRect().width;
    const visibleWidth = viewport.getBoundingClientRect().width;
    if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(visibleWidth)) return;
    const copies = Math.max(2, Math.ceil(visibleWidth / distance) + 1);
    while (track.children.length < copies) {
      const duplicate = document.createElement('span');
      duplicate.textContent = String(message || '');
      duplicate.setAttribute('aria-hidden', 'true');
      track.append(duplicate);
    }
    while (track.children.length > copies) track.lastElementChild.remove();
    // End exactly at the next copy's starting point for a seamless loop.
    track.style.setProperty(shiftProperty, `-${distance}px`);
    track.style.setProperty(durationProperty, `${Math.max(16, Math.min(72, distance / 32))}s`);
  }

  update();
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(first);
    return () => observer.disconnect();
  }
  window.addEventListener('resize', update);
  return () => window.removeEventListener('resize', update);
}
