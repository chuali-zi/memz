"""Synthetic regressions for leakage, fairness, denominator and reproducibility risks."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import retrieval_common as common
import retrieval_run as runner
import retrieval_score as scorer


class RetrievalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='memz-retrieval-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.corpora = self.root / 'corpora.jsonl'
        self.queries = self.root / 'queries.jsonl'
        self.gold = self.root / 'gold.private.jsonl'
        self.documents = [
            {'id': 'D1', 'session_id': 's1', 'date': None, 'text': 'apple 中文🙂'},
            {'id': 'D2', 'session_id': 's1', 'date': '2026-01-02', 'text': 'pear banana'},
            {'id': 'D3', 'session_id': 's2', 'date': '2026-01-03', 'text': 'pear apple'}]
        self.corpus_rows = [{'scope': 'scope-a', 'documents': self.documents},
                            {'scope': 'scope-b', 'documents': []}]
        self.query_rows = [{'id': 'q1', 'scope': 'scope-a', 'question': 'apple'},
                           {'id': 'q2', 'scope': 'scope-b', 'question': 'pear'}]
        self.gold_rows = [{'id': 'q1', 'category': '2', 'answer': 'EVALUATOR_ONLY', 'evidence_ids': ['D1']},
                          {'id': 'q2', 'category': '5', 'answer': 'none', 'evidence_ids': []}]
        self.save(self.corpora, self.corpus_rows)
        self.save(self.queries, self.query_rows)
        self.save(self.gold, self.gold_rows)

    def save(self, path, rows):
        path.write_text(''.join(common.canonical(row) + '\n' for row in rows), encoding='utf-8')

    def run_retrieval(self, name='run', **kwargs):
        path = self.root / name
        runner.run(self.corpora, self.queries, path, dev_scopes=1, **kwargs)
        return path

    def score(self, run, name='score'):
        path = self.root / name
        scorer.score(run, self.corpora, self.queries, self.gold, path, samples=50)
        return json.loads((path / 'summary.json').read_text())

    def test_gold_never_opened_and_nullable_generation_metrics(self):
        original_open = Path.open
        opened = []
        def checked_open(path, *args, **kwargs):
            opened.append(path.name)
            if 'gold' in path.name:
                raise AssertionError('retriever attempted to read gold')
            return original_open(path, *args, **kwargs)
        with patch.object(Path, 'open', checked_open):
            run = self.run_retrieval()
        self.assertNotIn('gold.private.jsonl', opened)
        rows = common.read_jsonl(run / 'retrieval.jsonl')
        self.assertEqual(len(rows), 8)
        for row in rows:
            for name in ['input_tokens', 'output_tokens', 'cost', 'generation_ms',
                         'end_to_end_generation_ms', 'answer_quality']:
                self.assertIsNone(row[name])
            self.assertNotIn('EVALUATOR_ONLY', common.canonical(row))

    def test_injected_labels_rejected_before_output(self):
        for target, field in [('query', 'answer'), ('query', 'category'), ('corpus', 'evidence'),
                              ('document', 'has_answer'), ('document', 'session_summary')]:
            with self.subTest(target=target, field=field):
                corpora = json.loads(json.dumps(self.corpus_rows))
                queries = json.loads(json.dumps(self.query_rows))
                item = queries[0] if target == 'query' else corpora[0]
                if target == 'document':
                    item = item['documents'][0]
                item[field] = 'FORBIDDEN'
                self.save(self.corpora, corpora)
                self.save(self.queries, queries)
                with self.assertRaisesRegex(ValueError, 'leakage'):
                    self.run_retrieval('rejected')
                self.assertFalse((self.root / 'rejected').exists())

    def test_duplicate_scope_document_and_query_ids_rejected(self):
        for target in ['corpus', 'document', 'query']:
            with self.subTest(target=target):
                corpora = json.loads(json.dumps(self.corpus_rows))
                queries = json.loads(json.dumps(self.query_rows))
                if target == 'corpus':
                    corpora.append(corpora[0])
                elif target == 'document':
                    corpora[0]['documents'].append(corpora[0]['documents'][0])
                else:
                    queries.append(queries[0])
                self.save(self.corpora, corpora)
                self.save(self.queries, queries)
                with self.assertRaisesRegex(ValueError, 'duplicate'):
                    self.run_retrieval('rejected')

    def test_unicode_exact_budget_whole_units_and_skip_oversized(self):
        documents = self.documents
        exact = len(common.context([documents[0]]))
        self.assertGreater(exact, len(common.context([documents[0]]).decode()))
        selected, skipped = runner.select(documents, [0], exact)
        self.assertEqual(selected, [documents[0]])
        self.assertEqual(skipped, [])
        self.assertEqual(runner.select(documents, [0], exact - 1)[0], [])
        pair_size = len(common.context(documents[:2]))
        self.assertEqual(len(runner.select(documents, [0, 1], pair_size)[0]), 2)
        self.assertEqual(len(runner.select(documents, [0, 1], pair_size - 1)[0]), 1)
        large = dict(documents[0], text='x' * 1000)
        selected, skipped = runner.select([large, documents[0]], [0, 1], exact)
        self.assertEqual(selected, [documents[0]])
        self.assertEqual(skipped, ['D1'])
        self.assertEqual(runner.select(documents, [0, 1], 0)[0], [])

    def test_empty_corpus_and_zero_terms_do_not_crash(self):
        self.assertEqual(runner.BM25([]).rank('apple'), [])
        self.assertEqual(runner.BM25([dict(self.documents[0], text='')]).rank('apple'), [])
        run = self.run_retrieval()
        rows = common.read_jsonl(run / 'retrieval.jsonl')
        for row in rows:
            if row['scope'] == 'scope-b':
                self.assertEqual(row['retrieved_ids'], [])
                self.assertIsNone(row['error'])
        summary = self.score(run)
        metric = summary['cohorts']['all/category:5']['methods']['bm25_raw']['metrics']['evidence_recall']
        self.assertEqual(metric['denominator_queries'], 0)
        self.assertIsNone(metric['mean'])

    def test_completely_empty_inputs(self):
        self.save(self.corpora, [])
        self.save(self.queries, [])
        self.save(self.gold, [])
        run = self.run_retrieval()
        self.assertEqual(common.read_jsonl(run / 'retrieval.jsonl'), [])
        self.assertEqual(self.score(run)['cohorts'], {})

    def test_bm25_ties_query_terms_and_recency_order(self):
        docs = [dict(d, text='apple') for d in self.documents]
        index = runner.BM25(docs)
        self.assertEqual(index.rank('apple'), [0, 1, 2])
        self.assertEqual(index.rank('apple apple'), [0, 1, 2])
        self.assertEqual(index.rank('missing'), [])
        run = self.run_retrieval(budget=10000)
        rows = common.read_jsonl(run / 'retrieval.jsonl')
        recency = next(r for r in rows if r['id'] == 'q1' and r['method'] == 'raw_budget_recency')
        self.assertEqual(recency['retrieved_ids'], ['D1', 'D2', 'D3'])

    def test_reproducible_except_measured_timings(self):
        a, b = self.run_retrieval('a'), self.run_retrieval('b')
        for filename, timing in [('retrieval.jsonl', 'retrieval_assembly_ms'), ('index.jsonl', 'index_build_ms')]:
            left, right = common.read_jsonl(a / filename), common.read_jsonl(b / filename)
            for row in left + right:
                row.pop(timing)
            self.assertEqual(left, right)
        self.assertEqual((a / 'manifest.json').read_bytes(), (b / 'manifest.json').read_bytes())
        rows = [{'scope': 'a', 'v': 0.0}, {'scope': 'a', 'v': 1.0}, {'scope': 'b', 'v': 1.0}]
        self.assertEqual(scorer.clustered_mean(rows, 'v', 100, 42), scorer.clustered_mean(rows, 'v', 100, 42))

    def test_output_overwrite_rejected_without_changes(self):
        run = self.run_retrieval()
        before = (run / 'retrieval.jsonl').read_bytes()
        with self.assertRaisesRegex(ValueError, 'output exists'):
            self.run_retrieval()
        self.assertEqual(before, (run / 'retrieval.jsonl').read_bytes())
        self.score(run)
        before = (self.root / 'score' / 'summary.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'output exists'):
            self.score(run)
        self.assertEqual(before, (self.root / 'score' / 'summary.json').read_bytes())

    def test_unresolved_evidence_is_not_repaired_and_denominators_explicit(self):
        evidence = ['D1', ' D1 ', 'D1, D2', {'bad': 'D1'}, 'D1']
        result = scorer.evidence_scores(evidence, {'D1'}, {'D1', 'D2'})
        self.assertEqual(result['evidence_ids_original'], evidence)
        self.assertEqual(result['evidence_references'], 4)
        self.assertEqual(result['duplicate_evidence_references'], 1)
        self.assertEqual(result['resolved_references'], 1)
        self.assertEqual(result['evidence_recall'], .25)
        self.assertEqual(result['evidence_all_hit'], 0)
        self.assertEqual(result['resolved_recall'], 1)
        self.gold_rows[0]['evidence_ids'] = [' D1 ']
        self.save(self.gold, self.gold_rows)
        summary = self.score(self.run_retrieval())
        metrics = summary['cohorts']['all/all_categories']['methods']['raw_full']['metrics']
        self.assertEqual(metrics['evidence_recall']['denominator_queries'], 1)
        self.assertEqual(metrics['resolved_recall']['denominator_queries'], 0)
        self.assertEqual(metrics['evidence_recall']['mean'], 0)

    def test_malformed_evidence_container_and_duplicate_gold_rejected(self):
        run = self.run_retrieval()
        self.gold_rows[0]['evidence_ids'] = 'D1'
        self.save(self.gold, self.gold_rows)
        with self.assertRaisesRegex(ValueError, 'evidence_ids must be a list'):
            self.score(run)
        self.assertFalse((self.root / 'score').exists())
        self.gold_rows[0]['evidence_ids'] = ['D1']
        self.save(self.gold, self.gold_rows + [self.gold_rows[0]])
        with self.assertRaisesRegex(ValueError, 'duplicate gold'):
            self.score(run)

    def test_missing_trace_is_failure_in_full_denominator_and_pairs(self):
        run = self.run_retrieval()
        rows = [r for r in common.read_jsonl(run / 'retrieval.jsonl')
                if not (r['id'] == 'q1' and r['method'] == 'raw_full')]
        self.save(run / 'retrieval.jsonl', rows)
        summary = self.score(run)
        full = summary['cohorts']['all/all_categories']['methods']['raw_full']
        self.assertEqual(full['queries'], 2)
        self.assertEqual(full['errors'], 1)
        self.assertEqual(full['metrics']['evidence_recall']['mean'], 0)
        paired = summary['cohorts']['all/all_categories']['paired_differences_vs_raw_budget_recency']
        self.assertEqual(paired['raw_full']['metrics']['evidence_recall']['mean'], -1)

    def test_retrieval_exception_retained_and_no_credit(self):
        with patch.object(runner.BM25, 'rank', side_effect=RuntimeError('synthetic failure')):
            run = self.run_retrieval()
        summary = self.score(run)
        bm25 = summary['cohorts']['all/all_categories']['methods']['bm25_raw']
        self.assertEqual(bm25['errors'], 2)
        self.assertEqual(bm25['metrics']['evidence_recall']['mean'], 0)

    def test_modified_inputs_duplicate_trace_and_tampered_context_rejected(self):
        run = self.run_retrieval()
        original = common.read_jsonl(run / 'retrieval.jsonl')
        self.save(run / 'retrieval.jsonl', original + [original[0]])
        with self.assertRaisesRegex(ValueError, 'duplicate or unexpected'):
            self.score(run)
        original[0]['context_bytes'] += 1
        self.save(run / 'retrieval.jsonl', original)
        with self.assertRaisesRegex(ValueError, 'context hash/bytes mismatch'):
            self.score(run)
        self.query_rows[0]['question'] = 'different'
        self.save(self.queries, self.query_rows)
        with self.assertRaisesRegex(ValueError, 'input hash mismatch'):
            self.score(run)

    def test_scope_split_stable_and_leaves_test(self):
        a = common.scope_split(['a', 'b', 'c'], 42, 1)
        self.assertEqual(a, common.scope_split(['c', 'a', 'b'], 42, 1))
        self.assertEqual(list(a.values()).count('dev'), 1)
        with self.assertRaisesRegex(ValueError, 'test scope'):
            common.scope_split(['a'], 42, 1)
        run = self.run_retrieval(split='test')
        rows = common.read_jsonl(run / 'retrieval.jsonl')
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(r['split'] == 'test' for r in rows))


if __name__ == '__main__':
    unittest.main()
