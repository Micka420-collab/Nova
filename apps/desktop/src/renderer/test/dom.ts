// Browser APIs jsdom lacks, emulated for renderer tests. Call once at the top of a DOM test file.

export function installDomPolyfills(): void {
  if (!window.matchMedia) {
    // Every media query reads "false": wide window, dark scheme, no reduced motion.
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
  }

  if (!("ResizeObserver" in window)) {
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.assign(window, { ResizeObserver: NoopResizeObserver });
  }

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }

  // Native modal dialogs: open attribute, focus on the first control, close event queued as a task.
  const dialog = HTMLDialogElement.prototype;
  if (!("__novaPolyfill" in dialog)) {
    Object.assign(dialog, {
      __novaPolyfill: true,
      showModal(this: HTMLDialogElement) {
        this.setAttribute("open", "");
        this.querySelector<HTMLElement>("button, input, textarea")?.focus();
      },
      close(this: HTMLDialogElement) {
        this.removeAttribute("open");
        setTimeout(() => this.dispatchEvent(new Event("close")));
      },
    });
  }
}
