#!/usr/bin/env python3
"""验证 execute-spec-tickets 的修复耗尽门禁。"""

from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("validate_ticket_gate.py")
SPEC = importlib.util.spec_from_file_location("validate_ticket_gate", MODULE_PATH)
assert SPEC and SPEC.loader
gate_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate_module)


class ValidateSkipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="ticket-gate-test-")
        self.repo = Path(self.temporary.name)
        self.ticket = "issues/04-example.md"
        (self.repo / "issues").mkdir()
        (self.repo / self.ticket).write_text(
            "# Ticket 04\n\n**Status:** ready-for-agent\n\n- [ ] 完成行为\n",
            encoding="utf-8",
        )
        self._git("init", "--quiet")
        self._git("config", "user.name", "Gate Test")
        self._git("config", "user.email", "gate@example.invalid")
        self._git("add", self.ticket)
        self._git("commit", "--quiet", "-m", "baseline")
        self.review_base = self._git("rev-parse", "HEAD").stdout.strip()
        (self.repo / self.ticket).write_text(
            "# Ticket 04\n\n**Status:** in-progress\n\n- [ ] 完成行为\n",
            encoding="utf-8",
        )
        self.snapshot = self.repo / ".snapshot"
        self.snapshot.mkdir()
        self.archive = self.repo / ".archive"
        self.archive.mkdir()
        (self.archive / "failure.patch").write_text("patch\n", encoding="utf-8")
        (self.archive / "untracked").mkdir()
        (self.archive / "recovery.md").write_text("恢复说明\n", encoding="utf-8")
        self.state_path = ".state.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args], cwd=self.repo, text=True, capture_output=True, check=True,
        )

    def _state(self) -> dict[str, object]:
        reviews = [
            {
                "reviewer": f"reviewer-{index}",
                "result": "blocked",
                "evidence": "阻断证据",
                "blocking_findings": [{
                    "id": f"R{index}-F1",
                    "severity": "P1",
                    "issue": f"第 {index} 轮阻断问题",
                    "impact": "acceptance-failure",
                    "evidence": "失败复现",
                }],
            }
            for index in range(1, 11)
        ]
        repairs = [
            {
                "round": index,
                "agent": f"repair-agent-{index}",
                "finding_ids": [f"R{index}-F1"],
                "resolutions": [{
                    "finding_id": f"R{index}-F1",
                    "status": "fixed",
                    "evidence": "修复证据",
                }],
                "evidence": "整批修复验证",
            }
            for index in range(1, 10)
        ]
        return {
            "phase": "repair-exhausted",
            "repair_round": 9,
            "current_ticket": self.ticket,
            "snapshot_dir": str(self.snapshot),
            "ticket_review_base": self.review_base,
            "ticket_gate": {
                "implementer": "implementer",
                "implementation_audit": {"status": "passed", "evidence": "审计通过"},
                "ownership_check": {"status": "passed", "evidence": "归属通过"},
                "diff_inspection": {"status": "passed", "evidence": "差异通过"},
                "review_history": reviews,
                "repair_history": repairs,
                "preexisting_paths": [
                    ".archive/failure.patch",
                    ".archive/recovery.md",
                ],
            },
            "blocking_findings": [{
                "id": "R10-F1",
                "severity": "P1",
                "issue": "第 10 轮阻断问题",
                "impact": "acceptance-failure",
                "affected_capabilities": "验收",
                "evidence": "失败复现",
            }],
            "repair_exhausted_archive": {
                "patch": str(self.archive / "failure.patch"),
                "untracked_backup": str(self.archive / "untracked"),
                "recovery_instructions": str(self.archive / "recovery.md"),
            },
            "workspace_isolation": {"status": "passed", "evidence": "只保留 Ticket 状态"},
            "candidate_assessments": [],
            "next_ticket": None,
        }

    def test_unbounded_user_override_rejects_skip(self) -> None:
        state = self._state()
        state["repair_limit_override"] = {
            "authorized_by_user": True,
            "tickets": ["04"],
            "unbounded_until_passed": True,
            "evidence": "用户明确要求持续修复直到通过",
        }

        with self.assertRaisesRegex(gate_module.GateError, "持续修复直到通过"):
            gate_module.validate_skip(self.repo, self.ticket, self.state_path, state)

    def test_unbounded_directive_without_evidence_still_rejects_skip(self) -> None:
        state = self._state()
        state["repair_limit_override"] = {
            "authorized_by_user": True,
            "tickets": ["04"],
            "unbounded_until_passed": True,
        }

        with self.assertRaisesRegex(gate_module.GateError, "持续修复直到通过"):
            gate_module.validate_skip(self.repo, self.ticket, self.state_path, state)

    def test_default_nine_round_exhaustion_allows_skip(self) -> None:
        gate_module.validate_skip(self.repo, self.ticket, self.state_path, self._state())

    def test_override_for_another_ticket_does_not_change_default_skip(self) -> None:
        state = self._state()
        state["repair_limit_override"] = {
            "authorized_by_user": True,
            "tickets": ["05"],
            "unbounded_until_passed": True,
            "evidence": "用户只授权 Ticket 05",
        }

        gate_module.validate_skip(self.repo, self.ticket, self.state_path, state)


if __name__ == "__main__":
    unittest.main()
