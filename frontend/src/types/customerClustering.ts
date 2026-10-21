export interface RfmValues { recency: number | null; frequency: number; monetary: number; }
export type CustomerFeatureName = 'recency' | 'frequency' | 'monetary';
export interface CustomerKMeansFeatureInput {
  name: CustomerFeatureName; rawValue: number; log1pValue: number; scaledValue: number;
}
export interface CustomerAssignmentBinding {
  businessId: string; scenarioId: string; datasetVersion: string;
  revision: string | null; snapshotHash: string | null; observedAt: string | null;
}
export interface CustomerClusterAssignment extends RfmValues {
  customerRef: string; status: 'ELIGIBLE' | 'ASSIGNED' | 'INSUFFICIENT_HISTORY'; rfmSegment: string | null;
  cluster: number | null; clusterName: string | null; distance: number | null; pc1: number | null; pc2: number | null;
  featureInputs?: CustomerKMeansFeatureInput[] | null;
}
export interface ClusteringCandidate {
  k: number; scaler: string; silhouetteMean: number; silhouetteStd: number; inertia: number;
  seedAriMean: number; subsampleAriMean: number; subsampleAriMin: number; clusterSizes: number[];
}
export interface CustomerClustering {
  contractVersion: string; modelId: string; version: string; algorithm: 'KMeans'; learningType: 'unsupervised'; task: string;
  trainingCutoff: string; sampleCount: number; excludedCount: number; features: string[]; featureWindow: string;
  transformations: string[]; scaler: string; k: number; randomState: number; nInit: number; status: 'EXPLORATORY';
  artifactHash: string; metrics: ClusteringCandidate; candidates: ClusteringCandidate[]; scalerSensitivityAri: number;
  selectionReason: string; protocolDeviation: string; limitations: string[];
  clusters: Array<{ cluster: number; name: string; size: number; proportion: number; centroidOriginal: RfmValues; mean: RfmValues; median: RfmValues; silhouetteMean: number }>;
  assignments: CustomerClusterAssignment[];
  pca: { explainedVarianceRatio: number[]; visualizationOnly: true }; assignmentAsOfDate: string;
  assignmentSource: 'FROZEN_TRAINING_RFM' | 'AUTHORIZED_CURRENT_RFM';
  assignmentBinding?: CustomerAssignmentBinding | null;
}
