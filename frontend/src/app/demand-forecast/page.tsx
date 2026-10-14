'use client';

import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { BusinessIntelligenceDashboard } from '@/components/business-intelligence/BusinessIntelligenceDashboard';

export default function DemandForecastPage() {
  return (
    <ProtectedRoute>
      <Layout>
        <BusinessIntelligenceDashboard />
      </Layout>
    </ProtectedRoute>
  );
}
