# Exploring MERMAID time series

A worked example showing which coral reef sites in [MERMAID](https://datamermaid.org/)
have publicly available **time series** - repeated surveys over several years - for one
or more sampling protocols.

The document is written for the MERMAID Analysis Hub. It starts from all publicly
available MERMAID summary data, works out how many years each site has been surveyed
for every combination of protocols, and shows the result on an interactive map.

## Rendered documents

| Document | Focus |
| --- | --- |
| [Exploring MERMAID time series](https://data-mermaid.github.io/analysis-explore-time-series/explore_time_series_map.html) | Interactive map of sites with repeated surveys, filtered by protocol and minimum number of years |
| [Time Series Explorer app](https://data-mermaid.github.io/analysis-explore-time-series/app/) | Standalone web app: the same map with an adjustable pairing window, country and project filters, and CSV download |
| [Index page](https://data-mermaid.github.io/analysis-explore-time-series/) | Links to the above |

The rendered HTML in `docs/` is what GitHub Pages serves, so it is committed to the
repository rather than ignored.

## The example

`analysis/explore_time_series_map.qmd`

- **Data:** every sample event from `mermaid_get_summary_sampleevents()`. Values are only
  filled in for protocols with a **public** or **public summary** data policy, so no API
  token is needed. Private projects are left out.
- **Protocols:** fish belt, benthic, bleaching and habitat complexity. The benthic
  protocols (PIT, LIT and PQT) are combined by averaging hard coral cover across them,
  ignoring missing values.
- **Repeats** are distinct calendar years with data.
- **Pairing:** when more than one protocol is selected, surveys are paired if every
  selected protocol was surveyed at the site within ±30 days of any one of those surveys.
  Each paired visit takes the year of its earliest survey. Unselected protocols are
  ignored, so each protocol added narrows the set of sites.
- All 15 protocol combinations are calculated in R, including a worked check of the
  pairing at one site. The browser then only filters and draws.
- **Outputs:** a summary of surveys per protocol; the number of sites reaching 1, 2, 3, 5
  and 10 years for every combination; and an interactive map with protocol check boxes
  and a minimum-years slider. Sites are coloured by number of years, and popups show the
  site, project, data policy per protocol and the years surveyed. A searchable table of
  the same sites sits below the map.

## How the interactive parts work

The map and table use [Observable JS](https://quarto.org/docs/interactive/ojs/) (`{ojs}`
chunks), which Quarto runs in the browser, so the published page needs no R server and
works on GitHub Pages. R hands its results over with `ojs_define()`. Leaflet is loaded
from a CDN when the page is opened, so viewing the map needs an internet connection.

`ojs_define()` only exists during a render. The R chunks can all be run interactively in
RStudio; the map-preparation chunk then prints a note instead, and the `{ojs}` chunks do
not run. Render the document to see the map.

## Time Series Explorer app

`docs/app/` is a standalone web app built from the same data and rules as the Quarto
document. It lives inside `docs/` because GitHub Pages only publishes from the repository
root or `docs/`, and it is plain HTML, CSS and JavaScript, so there is nothing to build.

- **Controls:** protocol check boxes, a pairing-window slider (±0 to 120 days), a
  minimum-years slider, and searchable country and project filters. The project list
  narrows to the countries chosen.
- **Pairing** is done in the browser (`docs/app/app.js`, function `pairedYears()`) using
  the same rule as the Quarto document. At ±30 days its counts match the Quarto
  document's summary table for all 15 protocol combinations.
- **Map:** Leaflet with Esri basemaps (light, ocean, satellite - no API key needed), sites
  coloured by number of years, and optional grouping of nearby sites, where each group
  takes the colour of its longest time series.
- **Site panel:** site, project, country, data policy and survey years per selected
  protocol, and a link to the project in MERMAID Explore.
- **Download:** the sites currently shown, as a CSV.

### Updating the app's data

The app reads `docs/app/data/app_data.json`, which `R/export_app_data.R` writes. It uses
the same cached `data/mermaid_summ_ses.rds` as the Quarto document (set
`force_download <- TRUE` in the script to fetch fresh data), so to refresh the app:

1. Open the `.Rproj` in RStudio.
2. Run `source("R/export_app_data.R")`.
3. Commit `docs/app/data/app_data.json`.

The presence rules in the script are copied from the Quarto document. If you change them
in one, change them in the other.

### Testing the app locally

Opening `docs/app/index.html` by double-clicking will not work: browsers do not let a page
opened from a file load another file (the data), so the page would stop at an error
message. Run a small local web server instead:

1. Open the `.Rproj` in RStudio.
2. Install the `servr` package once: `install.packages("servr")`.
3. Run `servr::httd("docs/app")` in the console.
4. It prints an address such as `http://127.0.0.1:4321`. Open that in your web browser
   (RStudio may also show it in the Viewer pane - use **Show in new window** for the
   full-size view).
5. After editing `app.js`, `app.css` or `index.html`, refresh the browser to see the
   change.
6. To stop the server, run `servr::daemon_stop()`, or restart R.

The app loads Leaflet and the map tiles from the internet, so you need to be online.

## Repository structure

```
analysis/
  _quarto.yml                    Quarto project; renders to ../docs
  index.qmd                      Landing page linking the documents
  explore_time_series_map.qmd    The time series map
  footer.html                    MERMAID logo footer
  2021MERMAIDLogoBlueTransp.png  Logo used by the footer
data/                            Cached data (created on first render, not committed)
R/
  export_app_data.R              Writes the app's data file
docs/                            Rendered HTML, published via GitHub Pages
  app/                           The Time Series Explorer app (index.html, app.js, app.css)
    data/app_data.json           The app's data, written by R/export_app_data.R
```

## Data and caching

The MERMAID export is not shipped with the repository. On the first render it is
downloaded and saved as `data/mermaid_summ_ses.rds`; later renders read that file.
Set `force_download <- TRUE` in the setup chunk, or delete the file, to fetch the latest
data. The status message under the download chunk shows when the cached copy was
downloaded.

Cache paths are built with `here::here("data", ...)`, after a call to `here::i_am()` in
the setup chunk. That call is **load-bearing**: `_quarto.yml` lives in `analysis/`, which
makes that folder look like a project root, so during a render `here::here()` would
otherwise resolve to `analysis/` and the cache would not be found.

## Prerequisites

R 4.1 or newer, [Quarto](https://quarto.org/), and:

```r
install.packages(c("here", "tidyverse", "jsonlite", "servr"))

# not on CRAN
remotes::install_github("data-mermaid/mermaidr")
```

The pairing uses an inequality join (`join_by(lower <= sample_date, ...)`), which needs
dplyr 1.1.0 or later.

## Reproducing

Open the `.Rproj` file, then either render from RStudio or, from a terminal at the
repository root:

```
quarto render analysis/explore_time_series_map.qmd
```

Output is written to `docs/`, as configured in `analysis/_quarto.yml`.

## License

Released under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE).
