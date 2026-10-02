use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, RwLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use numbat::{
    module_importer::BuiltinModuleImporter, resolver::CodeSource, value::Value, Context,
    InterpreterResult,
};
use serde::{Deserialize, Serialize};

const NUMBAT_ENGINE_VERSION: &str = "numbat-1.23.0";
const MAX_ABSOLUTE_INPUT: f64 = 1.0e15;
const MAX_ABSOLUTE_OUTPUT: f64 = 1.0e18;
const MAX_OPERATION_MILLIS: u128 = 500;
const MAX_CURRENCY_RATES: usize = 32;
const MAX_SOURCE_BYTES: usize = 128;
const MAX_CURRENT_RATE_AGE_DAYS: i64 = 7;
const ECB_SNAPSHOT_AS_OF: &str = "2026-08-03";
const ECB_SNAPSHOT_SOURCE: &str = "European Central Bank euro reference rates";
const BUNDLED_CURRENCY_SNAPSHOT_JSON: &str =
    include_str!("../resources/math-currency-rates-v1.json");

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum UnitId {
    Millimeter,
    Centimeter,
    Meter,
    Kilometer,
    Inch,
    Foot,
    Yard,
    Mile,
    Gram,
    Kilogram,
    Ounce,
    Pound,
    Millisecond,
    Second,
    Minute,
    Hour,
    Milliliter,
    Liter,
    CubicMeter,
    SquareCentimeter,
    SquareMeter,
    Hectare,
    MeterPerSecond,
    KilometerPerHour,
    MilePerHour,
    Newton,
    Joule,
    Watt,
    Pascal,
    Kilopascal,
    Bar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UnitDimension {
    Length,
    Mass,
    Time,
    Volume,
    Area,
    Speed,
    Force,
    Energy,
    Power,
    Pressure,
}

#[derive(Clone, Copy)]
struct UnitDefinition {
    expression: &'static str,
    dimension: UnitDimension,
}

fn unit_definition(id: UnitId) -> UnitDefinition {
    use UnitDimension as D;
    match id {
        UnitId::Millimeter => UnitDefinition {
            expression: "millimeter",
            dimension: D::Length,
        },
        UnitId::Centimeter => UnitDefinition {
            expression: "centimeter",
            dimension: D::Length,
        },
        UnitId::Meter => UnitDefinition {
            expression: "meter",
            dimension: D::Length,
        },
        UnitId::Kilometer => UnitDefinition {
            expression: "kilometer",
            dimension: D::Length,
        },
        UnitId::Inch => UnitDefinition {
            expression: "inch",
            dimension: D::Length,
        },
        UnitId::Foot => UnitDefinition {
            expression: "foot",
            dimension: D::Length,
        },
        UnitId::Yard => UnitDefinition {
            expression: "yard",
            dimension: D::Length,
        },
        UnitId::Mile => UnitDefinition {
            expression: "mile",
            dimension: D::Length,
        },
        UnitId::Gram => UnitDefinition {
            expression: "gram",
            dimension: D::Mass,
        },
        UnitId::Kilogram => UnitDefinition {
            expression: "kilogram",
            dimension: D::Mass,
        },
        UnitId::Ounce => UnitDefinition {
            expression: "ounce",
            dimension: D::Mass,
        },
        UnitId::Pound => UnitDefinition {
            expression: "pound",
            dimension: D::Mass,
        },
        UnitId::Millisecond => UnitDefinition {
            expression: "millisecond",
            dimension: D::Time,
        },
        UnitId::Second => UnitDefinition {
            expression: "second",
            dimension: D::Time,
        },
        UnitId::Minute => UnitDefinition {
            expression: "minute",
            dimension: D::Time,
        },
        UnitId::Hour => UnitDefinition {
            expression: "hour",
            dimension: D::Time,
        },
        UnitId::Milliliter => UnitDefinition {
            expression: "milliliter",
            dimension: D::Volume,
        },
        UnitId::Liter => UnitDefinition {
            expression: "liter",
            dimension: D::Volume,
        },
        UnitId::CubicMeter => UnitDefinition {
            expression: "meter^3",
            dimension: D::Volume,
        },
        UnitId::SquareCentimeter => UnitDefinition {
            expression: "centimeter^2",
            dimension: D::Area,
        },
        UnitId::SquareMeter => UnitDefinition {
            expression: "meter^2",
            dimension: D::Area,
        },
        UnitId::Hectare => UnitDefinition {
            expression: "hectare",
            dimension: D::Area,
        },
        UnitId::MeterPerSecond => UnitDefinition {
            expression: "meter / second",
            dimension: D::Speed,
        },
        UnitId::KilometerPerHour => UnitDefinition {
            expression: "kilometer / hour",
            dimension: D::Speed,
        },
        UnitId::MilePerHour => UnitDefinition {
            expression: "mile / hour",
            dimension: D::Speed,
        },
        UnitId::Newton => UnitDefinition {
            expression: "newton",
            dimension: D::Force,
        },
        UnitId::Joule => UnitDefinition {
            expression: "joule",
            dimension: D::Energy,
        },
        UnitId::Watt => UnitDefinition {
            expression: "watt",
            dimension: D::Power,
        },
        UnitId::Pascal => UnitDefinition {
            expression: "pascal",
            dimension: D::Pressure,
        },
        UnitId::Kilopascal => UnitDefinition {
            expression: "kilopascal",
            dimension: D::Pressure,
        },
        UnitId::Bar => UnitDefinition {
            expression: "bar",
            dimension: D::Pressure,
        },
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnitConversionRequest {
    value: f64,
    source_unit_id: UnitId,
    target_unit_id: UnitId,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitConversionResult {
    value: f64,
    unit_id: UnitId,
    engine: &'static str,
    duration_millis: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "UPPERCASE")]
pub enum CurrencyId {
    Chf,
    Eur,
    Usd,
    Gbp,
    Jpy,
    Cad,
    Aud,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CurrencySnapshotStatus {
    Current,
    Stale,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CurrencyRate {
    currency_id: CurrencyId,
    units_per_base: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CurrencyRateSnapshot {
    version: u8,
    base_currency_id: CurrencyId,
    as_of: String,
    source: String,
    rates: Vec<CurrencyRate>,
}

#[derive(Clone, Debug)]
struct ValidatedCurrencySnapshot {
    version: u8,
    base_currency_id: CurrencyId,
    as_of: String,
    as_of_epoch_day: i64,
    source: String,
    rates: HashMap<CurrencyId, f64>,
}

impl TryFrom<CurrencyRateSnapshot> for ValidatedCurrencySnapshot {
    type Error = MathUnitsFailure;

    fn try_from(value: CurrencyRateSnapshot) -> Result<Self, Self::Error> {
        let as_of_epoch_day =
            iso_date_to_epoch_day(&value.as_of).ok_or(MathUnitsFailure::CurrencySnapshotInvalid)?;
        if value.version != 1
            || !valid_source(&value.source)
            || value.rates.is_empty()
            || value.rates.len() > MAX_CURRENCY_RATES
        {
            return Err(MathUnitsFailure::CurrencySnapshotInvalid);
        }
        let mut currencies = HashSet::with_capacity(value.rates.len() + 1);
        currencies.insert(value.base_currency_id);
        let mut rates = HashMap::with_capacity(value.rates.len() + 1);
        rates.insert(value.base_currency_id, 1.0);
        for rate in value.rates {
            if !currencies.insert(rate.currency_id)
                || !rate.units_per_base.is_finite()
                || rate.units_per_base <= 0.0
                || rate.units_per_base > 1.0e9
            {
                return Err(MathUnitsFailure::CurrencySnapshotInvalid);
            }
            rates.insert(rate.currency_id, rate.units_per_base);
        }
        Ok(Self {
            version: value.version,
            base_currency_id: value.base_currency_id,
            as_of: value.as_of,
            as_of_epoch_day,
            source: value.source,
            rates,
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrencyConversionRequest {
    value: f64,
    source_currency_id: CurrencyId,
    target_currency_id: CurrencyId,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyConversionResult {
    value: f64,
    currency_id: CurrencyId,
    source: String,
    as_of: String,
    status: CurrencySnapshotStatus,
    snapshot_version: u8,
}

#[derive(Clone, Copy, Debug)]
enum MathUnitsFailure {
    InvalidInput,
    DimensionMismatch,
    UnitEngineUnavailable,
    UnitEngineTimeout,
    CurrencyUnavailable,
    UnknownCurrency,
    CurrencySnapshotInvalid,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MathUnitsCommandError {
    code: &'static str,
    message: &'static str,
}

impl From<MathUnitsFailure> for MathUnitsCommandError {
    fn from(value: MathUnitsFailure) -> Self {
        let (code, message) = match value {
            MathUnitsFailure::InvalidInput => {
                ("invalid-input", "The conversion request is invalid.")
            }
            MathUnitsFailure::DimensionMismatch => {
                ("dimension-mismatch", "The units are incompatible.")
            }
            MathUnitsFailure::UnitEngineUnavailable => {
                ("unit-engine-unavailable", "The unit engine is unavailable.")
            }
            MathUnitsFailure::UnitEngineTimeout => {
                ("unit-engine-timeout", "The unit conversion timed out.")
            }
            MathUnitsFailure::CurrencyUnavailable => (
                "currency-unavailable",
                "No trusted currency snapshot is available.",
            ),
            MathUnitsFailure::UnknownCurrency => (
                "unknown-currency",
                "The currency is unavailable in the trusted snapshot.",
            ),
            MathUnitsFailure::CurrencySnapshotInvalid => (
                "currency-snapshot-invalid",
                "The trusted currency snapshot is invalid.",
            ),
        };
        Self { code, message }
    }
}

#[derive(Clone)]
pub struct MathUnitsState {
    context: Arc<Option<Context>>,
    currency_snapshot: Arc<RwLock<Option<ValidatedCurrencySnapshot>>>,
}

impl MathUnitsState {
    pub fn new() -> Self {
        Self {
            context: Arc::new(build_context().ok()),
            currency_snapshot: Arc::new(RwLock::new(load_bundled_currency_snapshot().ok())),
        }
    }

    #[cfg(test)]
    fn with_test_snapshot(snapshot: CurrencyRateSnapshot) -> Result<Self, MathUnitsFailure> {
        let state = Self::new();
        *state
            .currency_snapshot
            .write()
            .map_err(|_| MathUnitsFailure::CurrencyUnavailable)? =
            Some(ValidatedCurrencySnapshot::try_from(snapshot)?);
        Ok(state)
    }

    fn convert_units(
        &self,
        request: UnitConversionRequest,
    ) -> Result<UnitConversionResult, MathUnitsFailure> {
        validate_number(request.value)?;
        let source = unit_definition(request.source_unit_id);
        let target = unit_definition(request.target_unit_id);
        if source.dimension != target.dimension {
            return Err(MathUnitsFailure::DimensionMismatch);
        }
        let started = Instant::now();
        let mut context = self
            .context
            .as_ref()
            .clone()
            .ok_or(MathUnitsFailure::UnitEngineUnavailable)?;
        // This is not renderer-provided code. Every token except the validated
        // finite number comes from the closed UnitId table above.
        let program = format!(
            "({:.17e} * ({})) -> ({})",
            request.value, source.expression, target.expression
        );
        let (_, result) = context
            .interpret(&program, CodeSource::Internal)
            .map_err(|_| MathUnitsFailure::UnitEngineUnavailable)?;
        let converted = match result {
            InterpreterResult::Value(Value::Quantity(quantity)) => quantity.unsafe_value().to_f64(),
            _ => return Err(MathUnitsFailure::UnitEngineUnavailable),
        };
        let elapsed_millis = started.elapsed().as_millis();
        if elapsed_millis > MAX_OPERATION_MILLIS {
            return Err(MathUnitsFailure::UnitEngineTimeout);
        }
        validate_output(converted)?;
        Ok(UnitConversionResult {
            value: converted,
            unit_id: request.target_unit_id,
            engine: NUMBAT_ENGINE_VERSION,
            duration_millis: elapsed_millis as u64,
        })
    }

    fn convert_currency(
        &self,
        request: CurrencyConversionRequest,
    ) -> Result<CurrencyConversionResult, MathUnitsFailure> {
        let today_epoch_day = current_utc_epoch_day()?;
        self.convert_currency_on_day(request, today_epoch_day)
    }

    fn convert_currency_on_day(
        &self,
        request: CurrencyConversionRequest,
        today_epoch_day: i64,
    ) -> Result<CurrencyConversionResult, MathUnitsFailure> {
        validate_number(request.value)?;
        let snapshot = self
            .currency_snapshot
            .read()
            .map_err(|_| MathUnitsFailure::CurrencyUnavailable)?
            .clone()
            .ok_or(MathUnitsFailure::CurrencyUnavailable)?;
        let source_rate = snapshot
            .rates
            .get(&request.source_currency_id)
            .copied()
            .ok_or(MathUnitsFailure::UnknownCurrency)?;
        let target_rate = snapshot
            .rates
            .get(&request.target_currency_id)
            .copied()
            .ok_or(MathUnitsFailure::UnknownCurrency)?;
        let converted = request.value / source_rate * target_rate;
        validate_output(converted)?;
        let status = currency_snapshot_status(snapshot.as_of_epoch_day, today_epoch_day);
        Ok(CurrencyConversionResult {
            value: converted,
            currency_id: request.target_currency_id,
            source: snapshot.source,
            as_of: snapshot.as_of,
            status,
            snapshot_version: snapshot.version,
        })
    }
}

fn load_bundled_currency_snapshot() -> Result<ValidatedCurrencySnapshot, MathUnitsFailure> {
    validate_bundled_currency_snapshot_json(BUNDLED_CURRENCY_SNAPSHOT_JSON)
}

fn validate_bundled_currency_snapshot_json(
    json: &str,
) -> Result<ValidatedCurrencySnapshot, MathUnitsFailure> {
    let raw = serde_json::from_str::<CurrencyRateSnapshot>(json)
        .map_err(|_| MathUnitsFailure::CurrencySnapshotInvalid)?;
    let snapshot = ValidatedCurrencySnapshot::try_from(raw)?;
    let expected = [
        CurrencyId::Eur,
        CurrencyId::Usd,
        CurrencyId::Jpy,
        CurrencyId::Gbp,
        CurrencyId::Chf,
        CurrencyId::Cad,
        CurrencyId::Aud,
    ];
    if snapshot.base_currency_id != CurrencyId::Eur
        || snapshot.as_of != ECB_SNAPSHOT_AS_OF
        || snapshot.source != ECB_SNAPSHOT_SOURCE
        || snapshot.rates.len() != expected.len()
        || expected
            .iter()
            .any(|currency_id| !snapshot.rates.contains_key(currency_id))
    {
        return Err(MathUnitsFailure::CurrencySnapshotInvalid);
    }
    Ok(snapshot)
}

fn current_utc_epoch_day() -> Result<i64, MathUnitsFailure> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| MathUnitsFailure::CurrencyUnavailable)?
        .as_secs();
    i64::try_from(seconds / 86_400).map_err(|_| MathUnitsFailure::CurrencyUnavailable)
}

fn currency_snapshot_status(as_of_epoch_day: i64, today_epoch_day: i64) -> CurrencySnapshotStatus {
    let age_days = today_epoch_day.checked_sub(as_of_epoch_day);
    if matches!(age_days, Some(0..=MAX_CURRENT_RATE_AGE_DAYS)) {
        CurrencySnapshotStatus::Current
    } else {
        CurrencySnapshotStatus::Stale
    }
}

fn build_context() -> Result<Context, MathUnitsFailure> {
    let mut context = Context::new(BuiltinModuleImporter::default());
    let _ = context
        .interpret("use prelude", CodeSource::Internal)
        .map_err(|_| MathUnitsFailure::UnitEngineUnavailable)?;
    Ok(context)
}

fn validate_number(value: f64) -> Result<(), MathUnitsFailure> {
    if !value.is_finite() || value.abs() > MAX_ABSOLUTE_INPUT {
        return Err(MathUnitsFailure::InvalidInput);
    }
    Ok(())
}

fn validate_output(value: f64) -> Result<(), MathUnitsFailure> {
    if !value.is_finite() || value.abs() > MAX_ABSOLUTE_OUTPUT {
        return Err(MathUnitsFailure::InvalidInput);
    }
    Ok(())
}

fn valid_source(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_SOURCE_BYTES && !value.chars().any(char::is_control)
}

fn iso_date_to_epoch_day(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let parse = |range: std::ops::Range<usize>| {
        std::str::from_utf8(&bytes[range]).ok()?.parse::<u32>().ok()
    };
    let year = parse(0..4)?;
    let month = parse(5..7)?;
    let day = parse(8..10)?;
    if year < 2000 || !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=max_day).contains(&day) {
        return None;
    }

    let adjusted_year = i64::from(year) - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

#[tauri::command]
pub async fn math_units_convert(
    state: tauri::State<'_, MathUnitsState>,
    request: UnitConversionRequest,
) -> Result<UnitConversionResult, MathUnitsCommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.convert_units(request))
        .await
        .map_err(|_| MathUnitsCommandError::from(MathUnitsFailure::UnitEngineUnavailable))?
        .map_err(MathUnitsCommandError::from)
}

#[tauri::command]
pub async fn math_currency_convert(
    state: tauri::State<'_, MathUnitsState>,
    request: CurrencyConversionRequest,
) -> Result<CurrencyConversionResult, MathUnitsCommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.convert_currency(request))
        .await
        .map_err(|_| MathUnitsCommandError::from(MathUnitsFailure::CurrencyUnavailable))?
        .map_err(MathUnitsCommandError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(value: f64, source_unit_id: UnitId, target_unit_id: UnitId) -> UnitConversionRequest {
        UnitConversionRequest {
            value,
            source_unit_id,
            target_unit_id,
        }
    }

    fn snapshot() -> CurrencyRateSnapshot {
        CurrencyRateSnapshot {
            version: 1,
            base_currency_id: CurrencyId::Chf,
            as_of: "2026-08-01".to_owned(),
            source: "SNB test fixture".to_owned(),
            rates: vec![
                CurrencyRate {
                    currency_id: CurrencyId::Eur,
                    units_per_base: 1.04,
                },
                CurrencyRate {
                    currency_id: CurrencyId::Usd,
                    units_per_base: 1.18,
                },
            ],
        }
    }

    fn day(value: &str) -> i64 {
        iso_date_to_epoch_day(value).expect("test date must be valid")
    }

    #[test]
    fn converts_representative_school_units_offline_with_numbat() {
        let state = MathUnitsState::new();
        let centimeters = state
            .convert_units(unit(1.25, UnitId::Meter, UnitId::Centimeter))
            .expect("length converts");
        let speed = state
            .convert_units(unit(10.0, UnitId::MeterPerSecond, UnitId::KilometerPerHour))
            .expect("speed converts");
        let area = state
            .convert_units(unit(2.0, UnitId::SquareMeter, UnitId::SquareCentimeter))
            .expect("area converts");
        let pressure = state
            .convert_units(unit(1.0, UnitId::Bar, UnitId::Kilopascal))
            .expect("pressure converts");
        assert!((centimeters.value - 125.0).abs() < 1.0e-10);
        assert!((speed.value - 36.0).abs() < 1.0e-10);
        assert!((area.value - 20_000.0).abs() < 1.0e-8);
        assert!((pressure.value - 100.0).abs() < 1.0e-10);
        assert_eq!(centimeters.engine, NUMBAT_ENGINE_VERSION);
        assert!(centimeters.duration_millis <= MAX_OPERATION_MILLIS as u64);
    }

    #[test]
    fn rejects_dimension_mismatch_and_non_finite_or_oversize_values() {
        let state = MathUnitsState::new();
        assert!(matches!(
            state.convert_units(unit(1.0, UnitId::Meter, UnitId::Second)),
            Err(MathUnitsFailure::DimensionMismatch)
        ));
        for value in [f64::NAN, f64::INFINITY, MAX_ABSOLUTE_INPUT * 2.0] {
            assert!(matches!(
                state.convert_units(unit(value, UnitId::Meter, UnitId::Centimeter)),
                Err(MathUnitsFailure::InvalidInput)
            ));
        }
    }

    #[test]
    fn serde_rejects_unknown_units_fields_and_injection_like_ids() {
        for json in [
            r#"{"value":1,"sourceUnitId":"meter; use evil","targetUnitId":"centimeter"}"#,
            r#"{"value":1,"sourceUnitId":"meter","targetUnitId":"centimeter","expression":"1 m -> cm"}"#,
            r#"{"value":1,"sourceUnitId":"meter","targetUnitId":"centimeter","requestId":"secret"}"#,
        ] {
            assert!(serde_json::from_str::<UnitConversionRequest>(json).is_err());
        }
    }

    #[test]
    fn production_load_contains_all_seven_ecb_currencies() {
        let state = MathUnitsState::new();
        let snapshot = state
            .currency_snapshot
            .read()
            .expect("snapshot lock is readable")
            .clone()
            .expect("bundled snapshot must load in production state");
        assert_eq!(snapshot.base_currency_id, CurrencyId::Eur);
        assert_eq!(snapshot.as_of, ECB_SNAPSHOT_AS_OF);
        assert_eq!(snapshot.source, ECB_SNAPSHOT_SOURCE);
        assert_eq!(snapshot.rates.len(), 7);
        for (currency_id, expected_rate) in [
            (CurrencyId::Eur, 1.0),
            (CurrencyId::Usd, 1.1535),
            (CurrencyId::Jpy, 180.73),
            (CurrencyId::Gbp, 0.85633),
            (CurrencyId::Chf, 0.9320),
            (CurrencyId::Cad, 1.6181),
            (CurrencyId::Aud, 1.6463),
        ] {
            assert_eq!(snapshot.rates.get(&currency_id), Some(&expected_rate));
        }
    }

    #[test]
    fn production_cross_rate_preserves_source_date_and_derives_status() {
        let state = MathUnitsState::new();
        let result = state
            .convert_currency_on_day(
                CurrencyConversionRequest {
                    value: 100.0,
                    source_currency_id: CurrencyId::Chf,
                    target_currency_id: CurrencyId::Jpy,
                },
                day("2026-08-03"),
            )
            .expect("currency converts");
        assert!((result.value - (100.0 / 0.9320 * 180.73)).abs() < 1.0e-10);
        assert_eq!(result.source, ECB_SNAPSHOT_SOURCE);
        assert_eq!(result.as_of, ECB_SNAPSHOT_AS_OF);
        assert_eq!(result.status, CurrencySnapshotStatus::Current);
    }

    #[test]
    fn currency_freshness_is_current_through_day_seven_and_stale_otherwise() {
        let state = MathUnitsState::new();
        let request = || CurrencyConversionRequest {
            value: 100.0,
            source_currency_id: CurrencyId::Eur,
            target_currency_id: CurrencyId::Usd,
        };
        for (today, expected) in [
            ("2026-08-03", CurrencySnapshotStatus::Current),
            ("2026-08-10", CurrencySnapshotStatus::Current),
            ("2026-08-11", CurrencySnapshotStatus::Stale),
            ("2026-08-02", CurrencySnapshotStatus::Stale),
        ] {
            let result = state
                .convert_currency_on_day(request(), day(today))
                .expect("currency converts");
            assert_eq!(result.status, expected, "unexpected status on {today}");
        }
    }

    #[test]
    fn trusted_test_snapshot_preserves_source_date_and_derives_stale_status() {
        let state =
            MathUnitsState::with_test_snapshot(snapshot()).expect("test snapshot validates");
        let result = state
            .convert_currency_on_day(
                CurrencyConversionRequest {
                    value: 100.0,
                    source_currency_id: CurrencyId::Eur,
                    target_currency_id: CurrencyId::Usd,
                },
                day("2026-08-09"),
            )
            .expect("currency converts");
        assert!((result.value - (100.0 / 1.04 * 1.18)).abs() < 1.0e-10);
        assert_eq!(result.source, "SNB test fixture");
        assert_eq!(result.as_of, "2026-08-01");
        assert_eq!(result.status, CurrencySnapshotStatus::Stale);
    }

    #[test]
    fn rejects_malformed_currency_snapshots_and_unknown_currency_pairs() {
        let mut invalid = snapshot();
        invalid.as_of = "2026-02-30".to_owned();
        assert!(matches!(
            MathUnitsState::with_test_snapshot(invalid),
            Err(MathUnitsFailure::CurrencySnapshotInvalid)
        ));
        let mut invalid_source = snapshot();
        invalid_source.source = "untrusted\nsource".to_owned();
        assert!(matches!(
            MathUnitsState::with_test_snapshot(invalid_source),
            Err(MathUnitsFailure::CurrencySnapshotInvalid)
        ));
        let mut duplicate = snapshot();
        duplicate.rates.push(CurrencyRate {
            currency_id: CurrencyId::Eur,
            units_per_base: 1.05,
        });
        assert!(matches!(
            MathUnitsState::with_test_snapshot(duplicate),
            Err(MathUnitsFailure::CurrencySnapshotInvalid)
        ));
        let state = MathUnitsState::with_test_snapshot(snapshot()).expect("snapshot validates");
        assert!(matches!(
            state.convert_currency(CurrencyConversionRequest {
                value: 10.0,
                source_currency_id: CurrencyId::Chf,
                target_currency_id: CurrencyId::Gbp,
            }),
            Err(MathUnitsFailure::UnknownCurrency)
        ));
    }

    #[test]
    fn bundled_snapshot_validation_rejects_malformed_or_wrong_provenance() {
        for json in [
            "not-json",
            r#"{"version":1,"baseCurrencyId":"EUR","asOf":"2026-08-03","source":"European Central Bank euro reference rates","status":"current","rates":[]}"#,
            &BUNDLED_CURRENCY_SNAPSHOT_JSON
                .replace(r#""baseCurrencyId": "EUR""#, r#""baseCurrencyId": "CHF""#),
            &BUNDLED_CURRENCY_SNAPSHOT_JSON.replace(ECB_SNAPSHOT_SOURCE, "Unknown source"),
            &BUNDLED_CURRENCY_SNAPSHOT_JSON.replace("1.1535", "0"),
        ] {
            assert!(matches!(
                validate_bundled_currency_snapshot_json(json),
                Err(MathUnitsFailure::CurrencySnapshotInvalid)
            ));
        }
    }

    #[test]
    fn embedded_snapshot_is_compile_time_packaged_and_has_expected_hash() {
        use sha2::{Digest, Sha256};

        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(BUNDLED_CURRENCY_SNAPSHOT_JSON.as_bytes())
            ),
            "cb9b1072cec06dcbb137776ed3fe25bcdee3e4bb1135177761f5167ab8fed42f"
        );
        assert_eq!(
            BUNDLED_CURRENCY_SNAPSHOT_JSON,
            include_str!("../resources/math-currency-rates-v1.json")
        );
    }

    #[test]
    fn opaque_errors_do_not_serialize_values_or_unit_programs() {
        let error = MathUnitsCommandError::from(MathUnitsFailure::DimensionMismatch);
        let serialized = serde_json::to_string(&error).expect("error serializes");
        assert_eq!(
            serialized,
            r#"{"code":"dimension-mismatch","message":"The units are incompatible."}"#
        );
        assert!(!serialized.contains("meter"));
    }
}
