# Verlauf und sichere Wiederherstellung

## Sicherheitsmodell

Der Seitenverlauf speichert vollständige, prüfbare Automerge-Dateien mit den
zugehörigen Heads, SHA-256, Zeitpunkt, Gerät und Typ. Benannte Prüfpunkte sind
manuell; automatische Punkte entstehen nach fünf Minuten oder zwanzig neuen
Automerge-Änderungen. Die Prüfung läuft erst, wenn zwei Sekunden lang nicht mehr
bearbeitet wurde (bei Dauereingabe spätestens jede Minute), damit ein
Snapshot einer grossen Seite das Tippen nicht anhält; der erste Punkt einer Seite
entsteht, sobald der Browser im Leerlauf ist (spätestens nach fünf Sekunden), und
nicht während die Seite öffnet. Papierkorb-Punkte bilden eine getrennte Aufbewahrungsspur.

Wiederherstellen ist absichtlich nicht destruktiv. Canvink lädt und prüft den
Snapshot, prüft alle referenzierten Assets und erstellt danach eine neue Seite
mit neuer Dokument-, Seiten- und Elementidentität. Die aktuelle Seite und
zwischenzeitliche Änderungen anderer Personen werden nicht zurückgespult oder
überschrieben. Ein expliziter destruktiver Rewind gehört nicht zum Produkt.

## Aufbewahrung

Pro Seite gelten standardmässig folgende Grenzen:

- 30 automatische Punkte; die ältesten werden erst nach bestätigtem Schreiben
  eines neuen Punkts mit einem SHA-256-Guard rotiert.
- 50 benannte manuelle Prüfpunkte; beim Erreichen der Grenze wird ein weiterer
  manueller Punkt abgelehnt und niemals stillschweigend gelöscht.
- 20 Papierkorb-Punkte; die ältesten werden wie automatische Punkte rotiert.

Browser und Desktop verwenden denselben `HistorySnapshotStore`-Vertrag. Der
Browser nutzt eine eigene IndexedDB-Ablage; neben jedem Snapshot liegt ein
kleiner Metadaten-Eintrag (`history-snapshot-meta:`), aus dem die Liste gelesen
wird, damit das Auflisten keine vollständigen Seitenkopien lädt. Snapshots aus
früheren Versionen erhalten ihren Eintrag beim ersten Auflisten. Desktop nutzt die bestehenden
SQLite-Snapshot-Befehle; `v2_delete_snapshot_guarded` verlangt zusätzlich den
erwarteten Inhaltshash.

## Integrität und Reparaturgrenze

Schema-v2-Start prüft zuerst `activation:v2`, danach Identität, Typ, Schema
und Heads der Notizbuch-Dokumente und der aktiven Seite sowie den
Arbeitsbereichsgraphen anhand der Seitenübersichten. Jede weitere Seite wird
beim Laden gleich geprüft (Identität, Typ, Schema, enthaltene
Aktivierungs-Heads), jedes Asset beim Lesen gegen Grösse und SHA-256, das
schema-v1-Backup, wenn die Rollback-Kopie gebraucht wird. Fehler in diesen
Quelldaten führen zu `WorkspaceV2RecoveryRequiredError`; Canvink fällt weder
auf schema v1 zurück noch erzeugt es einen leeren Arbeitsbereich. Seiten
werden bei Bedarf geladen (siehe `docs/automerge-architecture.md`, Abschnitt
«Lazy page loading»).

Snapshots werden beim Laden nochmals gegen Grösse und SHA-256 geprüft. Ein
beschädigter Snapshot kann weder in der Vorschau geöffnet noch wiederhergestellt
oder unbemerkt rotiert werden. Nur abgeleitete Daten wie die lokale FTS-Suche
dürfen aus den geprüften Automerge-Quellen neu aufgebaut werden. Aktivierung,
Repo, Dokumente, Assets und Snapshots werden nicht durch eine Index-Reparatur
verändert.

## UI-Vertrag

`HistoryPanel` zeigt Zeitpunkt, Name, lokales Gerät, Typ, Änderungen seit dem
Punkt, Elementdifferenz und Automerge-Konfliktzahlen. Automatische Erfassung
läuft über die bestehende Seitenänderungs-Subscription auch bei geschlossenem
Panel. Löschen verlangt eine sichtbare Bestätigung und bleibt im Store zusätzlich
hashgeschützt.

## Noch ausstehender persönlicher Drill

Die technische lokale Wiederherstellung ersetzt kein persönliches
Geräte-Backup. Vor einer öffentlichen Beta bleibt ein manueller Drill offen:
ein vollständiges `.canvink`-Bundle exportieren und hashen, in einer separat
verschlüsselten Sicherungsablage speichern, auf einem getrennten Testprofil
wiederherstellen, Startintegrität prüfen und eine Verlaufskopie mit Rich Text,
Bild und PDF öffnen. Das portable Bundle selbst ist nicht verschlüsselt.
Zugangsdaten oder private Notizdaten gehören nicht in den Drill-Bericht.
