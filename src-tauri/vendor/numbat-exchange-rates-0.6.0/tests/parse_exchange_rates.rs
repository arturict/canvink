use numbat_exchange_rates::parse_exchange_rates;
use quick_xml::{events::Event, reader::Reader};

const ECB_SAMPLE: &str = r#"
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"
                 xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time="2026-08-03">
      <Cube currency="USD" rate="1.1579"/>
      <Cube currency="CHF" rate="0.9345"/>
    </Cube>
  </Cube>
</gesmes:Envelope>
"#;

#[test]
fn parses_representative_ecb_rates_with_quick_xml_0_41() {
    let rates = parse_exchange_rates(ECB_SAMPLE).expect("valid ECB XML should parse");

    assert_eq!(rates.len(), 2);
    assert_eq!(rates.get("USD"), Some(&1.1579));
    assert_eq!(rates.get("CHF"), Some(&0.9345));
}

#[test]
fn quick_xml_0_41_detects_duplicates_after_the_hash_threshold() {
    let unique_attributes = (0..128)
        .map(|index| format!(r#" a{index}="{index}""#))
        .collect::<String>();
    let duplicate = format!(r#"<Cube{unique_attributes} a0="duplicate"/>"#);
    let mut reader = Reader::from_str(&duplicate);
    let event = reader.read_event().expect("test XML should tokenize");
    let Event::Empty(element) = event else {
        panic!("expected one empty Cube element");
    };

    assert!(element.attributes().any(|attribute| attribute.is_err()));
}

#[test]
fn rejects_invalid_rates() {
    let invalid = r#"<Cube currency="CHF" rate="not-a-number"/>"#;

    assert_eq!(parse_exchange_rates(invalid), None);
}
