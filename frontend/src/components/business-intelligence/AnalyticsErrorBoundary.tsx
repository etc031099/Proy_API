'use client';

import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** A render failure stays within its analytics module; retry remounts its data loader. */
export class AnalyticsErrorBoundary extends Component<{ label: string; children: ReactNode }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div role="alert" className="space-y-3 rounded-lg border p-5">
      <p>No se pudo mostrar la analítica de {this.props.label}.</p>
      <Button variant="outline" onClick={() => this.setState(state => ({ failed: false, attempt: state.attempt + 1 }))}>Reintentar</Button>
    </div>;
    return <div key={this.state.attempt}>{this.props.children}</div>;
  }
}
