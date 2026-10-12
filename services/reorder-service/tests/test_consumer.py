import json
from conftest import EventFactory

import pytest

from reorder.consumer import Backoff, process_batch, rewind_points


class Msg:
    def __init__(self, value, offset=0, partition=0, err=None):
        self._v, self._o, self._p, self._e = value, offset, partition, err

    def error(self):
        return self._e

    def value(self):
        return self._v

    def topic(self):
        return "partflow.inventory"

    def partition(self):
        return self._p

    def offset(self):
        return self._o


def test_handles_in_order_and_skips_poison_messages(handler):
    f = EventFactory()
    good = f.consume(5)
    msgs = [Msg(b"{not json", 0), Msg(json.dumps(good).encode(), 1), Msg(json.dumps({"eventId": "x"}).encode(), 2), Msg(json.dumps(good).encode(), 3)]
    committed = []
    counts = process_batch(handler, msgs, committed.append)
    assert counts == {"malformed": 1, "evaluated": 1, "invalid": 1, "duplicate": 1}
    assert [m.offset() for m in committed] == [0, 1, 2, 3]


def test_transient_failures_propagate_without_commit(handler, monkeypatch):
    def boom(_):
        raise ConnectionError("mongo unreachable")

    monkeypatch.setattr(handler, "handle", boom)
    committed = []
    with pytest.raises(ConnectionError):
        process_batch(handler, [Msg(json.dumps(EventFactory().consume(1)).encode())], committed.append)
    assert committed == []


def test_rewind_points_and_backoff():
    tps = rewind_points([Msg(b"", 7, 0), Msg(b"", 5, 0), Msg(b"", 9, 1), Msg(b"", 1, 2, err="x")])
    assert sorted((tp.partition, tp.offset) for tp in tps) == [(0, 5), (1, 9)]
    b = Backoff(base=1, cap=4)
    assert [b.next() for _ in range(4)] == [1, 2, 4, 4]
    b.reset()
    assert b.next() == 1
