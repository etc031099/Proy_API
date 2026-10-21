'use client';

import { Component, type ReactNode } from 'react';

/** A legacy/malformed response must not unmount chat, history or the input. */
export class AssistantResponseBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <p role="alert" className="text-sm text-muted-foreground">No se pudo mostrar esta respuesta.</p>
      : this.props.children;
  }
}
