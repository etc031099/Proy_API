"""Small offline exporter checks: no fits, database or replay execution."""
import unittest
from ml.replay.export_certificate_detail import equivalent, origin_rows, focal_evidence


class CertificateDetailTests(unittest.TestCase):
    def test_origin_groups_all_skus_and_preserves_paired_error_semantics(self):
        samples = [dict(sku='a', origin='2026-04-17', actual=2., prediction=4., baseline=1.),
                   dict(sku='b', origin='2026-04-17', actual=6., prediction=3., baseline=5.),
                   dict(sku='a', origin='2026-04-18', actual=0., prediction=0., baseline=1.)]
        rows = origin_rows('F2', samples)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['sampleCount'], 2)
        self.assertEqual(rows[0]['actualUnits'], 8)
        self.assertEqual(rows[0]['candidate']['mae'], 2.5)
        self.assertEqual(rows[0]['candidate']['wape'], 5 / 8)
        self.assertEqual(rows[0]['candidate']['normalized_bias'], -1 / 8)
        self.assertIsNone(rows[1]['candidate']['wape'])
        self.assertIsNone(rows[1]['candidate']['normalized_bias'])
        self.assertEqual(rows, origin_rows('F2', samples))

    def test_certificate_comparison_checks_every_field_and_safe_float_tolerance(self):
        self.assertTrue(equivalent({'x': [1., 'PASS']}, {'x': [1. + 1e-12, 'PASS']}))
        self.assertFalse(equivalent({'x': [1., 'PASS']}, {'x': [1.1, 'PASS']}))
        self.assertFalse(equivalent({'x': [1.]}, {'x': [1.], 'extra': 1}))
        self.assertFalse(equivalent(True, 1))

    def test_focal_certificate_cannot_be_built_without_actual_failed_check(self):
        with self.assertRaisesRegex(ValueError, 'REPLAY_CERTIFICATE_MISMATCH'):
            focal_evidence({'reasons': [], 'checks': {}})


if __name__ == '__main__':
    unittest.main()
