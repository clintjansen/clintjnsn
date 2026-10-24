/**
 * Reusable JNSN® wordmark. Import this module once, then use:
 * <jnsn-wordmark href="/" label="JNSN home"></jnsn-wordmark>
 * Optional CSS variables: --jnsn-wordmark-size (29px), --jnsn-wordmark-color.
 * No framework, font download, image asset, or build step is required.
 */
export class JnsnWordmark extends HTMLElement {
  static observedAttributes = ['href', 'label', 'target'];

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { display: inline-block; vertical-align: middle; }
        a {
          display: inline-block;
          font: 900 var(--jnsn-wordmark-size, 29px)/1 Arial, sans-serif;
          color: var(--jnsn-wordmark-color, #171715);
          text-decoration: none;
          letter-spacing: -.0689655172em;
          white-space: nowrap;
        }
        span {
          font-size: .3793103448em;
          vertical-align: top;
          letter-spacing: 0;
          margin-left: .3636363636em;
        }
        a:focus-visible { outline: 2px solid currentColor; outline-offset: 5px; }
      </style>
      <a>JNSN<span aria-hidden="true">®</span></a>`;
    this.anchor = root.querySelector('a');
  }

  connectedCallback() { this.updateLink(); }
  attributeChangedCallback() { if (this.anchor) this.updateLink(); }

  updateLink() {
    this.anchor.setAttribute('href', this.getAttribute('href') || '/');
    this.anchor.setAttribute('aria-label', this.getAttribute('label') || 'JNSN home');
    const target = this.getAttribute('target');
    if (target) this.anchor.setAttribute('target', target);
    else this.anchor.removeAttribute('target');
    if (target === '_blank') this.anchor.setAttribute('rel', 'noopener noreferrer');
    else this.anchor.removeAttribute('rel');
  }
}

if (!customElements.get('jnsn-wordmark')) customElements.define('jnsn-wordmark', JnsnWordmark);
