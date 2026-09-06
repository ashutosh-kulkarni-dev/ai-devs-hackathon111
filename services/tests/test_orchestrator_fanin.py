"""Phase 3 tests (plan_3.md): orchestrator fan-in correctness.

- A 2-agent dispatch plan doesn't hang forever waiting for a third result
  that will never arrive -- the join-timeout sweeper completes it with a
  partial report instead.
- A redelivered `investigation-tasks` message doesn't clobber already
  collected results (idempotent dispatch).
- A result for a case with no recorded plan is held (raises, so Phase 1
  nacks/redelivers) rather than assuming a 3-agent expectation.
"""
import pytest
from load_service import load_module


@pytest.fixture
def orchestrator(monkeypatch):
    module = load_module("orchestrator_svc", "orchestrator/orchestrator.py")
    monkeypatch.setattr(module, "log_event", lambda *a, **k: None)
    published = []
    monkeypatch.setattr(module, "publish_json", lambda topic, payload: published.append((topic, payload)))
    module._test_published = published
    monkeypatch.setattr(module, "get_dispatch_plan", lambda message: module._test_plan)
    return module


def _report_tasks(orchestrator):
    return [payload for topic, payload in orchestrator._test_published if topic == "report-generator-tasks"]


def test_two_agent_plan_completes_without_third_result(orchestrator):
    orchestrator._test_plan = {"dispatch": ["kyc_retriever", "transaction_analyzer"], "reasoning": "test"}
    orchestrator.dispatch_investigation({"case_id": "CASE-1", "customer_id": "C1", "account_id": "A1"})

    orchestrator._make_result_handler("kyc-retriever-results")({
        "case_id": "CASE-1", "result": {"evidence": [], "notes": "kyc done"},
    })
    orchestrator._make_result_handler("transaction-analyzer-results")({
        "case_id": "CASE-1", "result": {"evidence": [], "notes": "txn done"},
    })

    # Both expected results are in -- report task fires immediately, no
    # timeout needed, and it does NOT wait for a fraud_case_search result
    # that was never dispatched.
    reports = _report_tasks(orchestrator)
    assert len(reports) == 1
    assert reports[0]["partial"] is False


def test_join_timeout_completes_case_with_missing_agent(orchestrator):
    orchestrator._test_plan = {"dispatch": ["kyc_retriever", "transaction_analyzer"], "reasoning": "test"}
    orchestrator.JOIN_TIMEOUT_SECONDS = 0  # force-expire immediately for the test
    orchestrator.dispatch_investigation({"case_id": "CASE-2", "customer_id": "C1", "account_id": "A1"})

    orchestrator._make_result_handler("kyc-retriever-results")({
        "case_id": "CASE-2", "result": {"evidence": [], "notes": "kyc done"},
    })
    # transaction_analyzer never reports back.

    # _sweep_incomplete_cases() loops forever; run its body once instead.
    _run_one_sweep(orchestrator)

    reports = _report_tasks(orchestrator)
    assert len(reports) == 1
    assert reports[0]["partial"] is True
    assert reports[0]["missing_agents"] == ["transaction_analyzer"]
    # The case did complete -- not silently hung.
    assert reports[0]["case_id"] == "CASE-2"


def _run_one_sweep(orchestrator):
    """_sweep_incomplete_cases() loops forever; run its body once."""
    import time
    now = time.time()
    timed_out = []
    with orchestrator._lock:
        for case_id, state in orchestrator._case_state.items():
            if state.get("report_requested"):
                continue
            if now - state.get("dispatched_at", now) >= orchestrator.JOIN_TIMEOUT_SECONDS:
                state["report_requested"] = True
                missing_keys = state["expected_state_keys"] - state["results"].keys()
                missing_agents = sorted(orchestrator.STATE_KEY_TO_WORKER.get(k, k) for k in missing_keys)
                timed_out.append((case_id, state.get("correlation_id", case_id), dict(state), missing_agents))
    for case_id, correlation_id, state_snapshot, missing_agents in timed_out:
        orchestrator._publish_report_task(case_id, correlation_id, state_snapshot, partial=True,
                                           missing_agents=missing_agents)


def test_redelivered_dispatch_does_not_clobber_collected_results(orchestrator):
    orchestrator._test_plan = {
        "dispatch": ["kyc_retriever", "transaction_analyzer", "fraud_case_search"], "reasoning": "test",
    }
    message = {"case_id": "CASE-3", "customer_id": "C1", "account_id": "A1"}
    orchestrator.dispatch_investigation(message)

    orchestrator._make_result_handler("kyc-retriever-results")({
        "case_id": "CASE-3", "result": {"evidence": [], "notes": "kyc done"},
    })

    # investigation-tasks redelivered (e.g. dispatch_investigation raised
    # partway through on the first attempt) -- must not wipe kyc_summary.
    orchestrator.dispatch_investigation(message)

    with orchestrator._lock:
        state = orchestrator._case_state["CASE-3"]
    assert "kyc_summary" in state["results"]

    # And it must not have re-published duplicate task messages.
    dispatch_topics = [t for t, _ in orchestrator._test_published if t.endswith("-tasks") and t != "report-generator-tasks"]
    assert dispatch_topics.count("kyc-retriever-tasks") == 1


def test_result_for_unknown_case_raises_instead_of_guessing_expected_set(orchestrator):
    handler = orchestrator._make_result_handler("kyc-retriever-results")
    with pytest.raises(RuntimeError):
        handler({"case_id": "CASE-NEVER-DISPATCHED", "result": {"evidence": [], "notes": "x"}})
