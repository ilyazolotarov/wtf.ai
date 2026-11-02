import pytest

from tiles.hours import DAY_MIN, WEEK_MIN, week_hours


def at(day: int, hh: int, mm: int = 0) -> int:
    return day * DAY_MIN + hh * 60 + mm


def daily(start: tuple[int, int], end: tuple[int, int], days=range(7)) -> tuple[tuple[int, int], ...]:
    return tuple((at(d, *start), at(d, *end)) for d in days)


def test_whole_week():
    assert week_hours("24/7") == ((0, WEEK_MIN),)
    assert week_hours("Mo-Su 00:00-24:00") == ((0, WEEK_MIN),)
    assert week_hours("PH,Mo-Su 00:00-24:00") == ((0, WEEK_MIN),)
    assert week_hours("Mo-Su,PH 00:00-00:00") == ((0, WEEK_MIN),)
    assert week_hours("24/7; PH off") == ((0, WEEK_MIN),)


def test_every_day_the_same():
    assert week_hours("Mo-Su 08:00-21:00") == daily((8, 0), (21, 0))
    assert week_hours("08:00 - 22:00") == daily((8, 0), (22, 0))
    assert week_hours("mo-su 10:00-22:00") == daily((10, 0), (22, 0))
    assert week_hours("Mo-Su, PH 08:00-20:00") == daily((8, 0), (20, 0))


def test_weekdays_and_weekends():
    expected = daily((8, 0), (21, 0), range(5)) + daily((9, 0), (21, 0), (5, 6))
    for v in ("Mo-Fr 08:00-21:00; Sa, Su 09:00-21:00", "Mo-Fr 08:00-21:00;Sa-Su 09:00-21:00", "mo-fr 08:00-21:00, Sa-Su 09:00-21:00"):
        assert week_hours(v) == expected, v
    # Days no rule names are closed; off closes the days it names.
    assert week_hours("Mo-Fr 09:00-18:00") == daily((9, 0), (18, 0), range(5))
    assert week_hours("Mo-Sa 08:00-20:00; Su off") == daily((8, 0), (20, 0), range(6))
    assert week_hours("mo-sa 08:00-20:00, su off") == daily((8, 0), (20, 0), range(6))
    assert week_hours("Mo-Fr 12:00-23:00; Sa 17:00-23:00; PH,Su off") == daily((12, 0), (23, 0), range(5)) + ((at(5, 17), at(5, 23)),)


def test_a_later_rule_replaces_the_days_it_names():
    assert week_hours("Mo-Su 08:00-22:00; Su 10:00-18:00") == daily((8, 0), (22, 0), range(6)) + ((at(6, 10), at(6, 18)),)


def test_a_lunch_break_and_single_digit_hours():
    assert week_hours("Mo-Fr 9:00-13:00,14:00-18:00") == tuple(r for d in range(5) for r in ((at(d, 9), at(d, 13)), (at(d, 14), at(d, 18))))


def test_past_midnight_into_the_next_day_and_the_week_wraps():
    assert week_hours("Mo-Su 11:00-00:00") == daily((11, 0), (24, 0))
    # Friday and Saturday nights to 02:00; Sunday's night runs into Monday morning.
    assert week_hours("Fr-Sa 18:00-02:00") == ((at(4, 18), at(5, 2)), (at(5, 18), at(6, 2)))
    assert week_hours("Su 20:00-03:00") == ((0, at(0, 3)), (at(6, 20), WEEK_MIN))
    # Back to back days join.
    assert week_hours("Mo-Su 18:00-06:00") == ((0, at(0, 6)),) + tuple((at(d, 18), at(d + 1, 6)) for d in range(6)) + ((at(6, 18), WEEK_MIN),)


def test_an_open_end_reads_as_the_end_given():
    assert week_hours("09:00-23:00+") == daily((9, 0), (23, 0))


def test_closed_always():
    assert week_hours("closed") == ()
    assert week_hours("off") == ()
    assert week_hours("Mo-Su off") == ()


def test_closing_some_days_alone_says_nothing_of_the_others():
    assert week_hours("PH off") is None
    assert week_hours("Su off") is None
    assert week_hours("Sa,Su closed; PH off") is None


def test_a_rule_of_holidays_alone_is_skipped():
    assert week_hours("Mo-Su 11:00-22:00; PH closed") == daily((11, 0), (22, 0))


@pytest.mark.parametrize("value", [
    None, "", "sunrise-sunset", '"зал 09:00 - 22:00\nmc drive 07:00 - 23:00"', "Jan-Mar Mo-Fr 08:00-17:00",
    "Mo-Fr 08:00+", "Mo-Fr 25:00-26:00", "Mo-Fr 08:00-12:61", "by appointment", "Mo-Fr 08:00-12:00 || closed",
])
def test_unknown(value):
    assert week_hours(value) is None
