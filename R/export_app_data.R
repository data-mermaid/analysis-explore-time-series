# Export the data used by the time series explorer app (docs/app/)
#
# Open the .Rproj, then source this file (or run it line by line). It reads the
# cached MERMAID export in data/ - the same file the Quarto document uses - or
# downloads it if it is missing, and writes docs/app/data/app_data.json.
#
# The presence rules are copied from analysis/explore_time_series_map.qmd, so
# both give the same surveys. If you change them in one place, change them in
# the other. Surveys with a private data policy are exported too; the app
# leaves them out unless "Include private data" is switched on.
#
# The app does the pairing itself (in docs/app/app.js), so this file only
# exports one row per site and one row per site-day and protocol.

library(here)
here::i_am("R/export_app_data.R")
library(tidyverse)
library(mermaidr)
library(jsonlite)

# Set this to TRUE to re-download the MERMAID data instead of using the cache
force_download <- FALSE

# Same keys and labels as the Quarto document. The order matters: the app
# refers to protocols by their position in this vector.
protocols <- c(fish      = "Fish belt",
               benthic   = "Benthic (PIT, LIT, PQT)",
               bleaching = "Bleaching",
               habitat   = "Habitat complexity")

# Survey (sample unit) count columns, which show whether a protocol was
# surveyed. Unlike the values, these are filled in for every data policy -
# including private - so they decide whether a protocol is present.
su_cols <- list(
  fish      = "beltfish_sample_unit_count",
  benthic   = c("benthicpit_sample_unit_count", "benthiclit_sample_unit_count",
                "benthicpqt_sample_unit_count"),
  bleaching = c("colonies_bleached_sample_unit_count",
                "quadrat_benthic_percent_sample_unit_count"),
  habitat   = "habitatcomplexity_sample_unit_count"
)

# Data policies are sent to the app as numbers to keep the file small
policy_codes <- c("public summary" = 1L, "public" = 2L, "private" = 3L)

out_path <- here::here("docs", "app", "data", "app_data.json")

#### Load the MERMAID summary sample events ####
mermaid_summ_ses_path <- here::here("data", "mermaid_summ_ses.rds")

if (file.exists(mermaid_summ_ses_path) && !force_download) {
  mermaid_summ_ses <- readRDS(mermaid_summ_ses_path)
  message("Loaded cached sample events from data/mermaid_summ_ses.rds")
} else {
  mermaid_summ_ses <- mermaid_get_summary_sampleevents()
  dir.create(dirname(mermaid_summ_ses_path), showWarnings = FALSE, recursive = TRUE)
  saveRDS(mermaid_summ_ses, mermaid_summ_ses_path)
  message("Downloaded sample events from MERMAID and saved them to data/mermaid_summ_ses.rds")
}
downloaded_on <- as.Date(file.mtime(mermaid_summ_ses_path))

required_cols <- c("site_id", "site", "project_id", "project", "country",
                   "latitude", "longitude", "sample_date",
                   "data_policy_beltfish", "data_policy_benthicpit",
                   "data_policy_benthiclit", "data_policy_benthicpqt",
                   "data_policy_bleachingqc", "data_policy_habitatcomplexity",
                   unlist(su_cols))
missing_cols <- setdiff(required_cols, names(mermaid_summ_ses))
if (length(missing_cols) > 0) {
  stop("These expected columns are missing from the MERMAID export: ",
       paste(missing_cols, collapse = ", "))
}

#### Surveys by protocol (same rules as the Quarto document) ####
ses <- mermaid_summ_ses %>%
  mutate(
    sample_date = as.Date(sample_date),
    policy_benthic = case_when(
      !is.na(benthicpit_sample_unit_count) ~ data_policy_benthicpit,
      !is.na(benthiclit_sample_unit_count) ~ data_policy_benthiclit,
      !is.na(benthicpqt_sample_unit_count) ~ data_policy_benthicpqt
    )
  )

# One row per sample event and protocol - comparable with MERMAID Explore
survey_events <- bind_rows(
  ses %>%
    filter(if_any(all_of(su_cols$fish), \(x) !is.na(x) & x > 0)) %>%
    transmute(site_id, sample_date, protocol = "fish",
              policy = data_policy_beltfish),
  ses %>%
    filter(if_any(all_of(su_cols$benthic), \(x) !is.na(x) & x > 0)) %>%
    transmute(site_id, sample_date, protocol = "benthic",
              policy = policy_benthic),
  ses %>%
    filter(if_any(all_of(su_cols$bleaching), \(x) !is.na(x) & x > 0)) %>%
    transmute(site_id, sample_date, protocol = "bleaching",
              policy = data_policy_bleachingqc),
  ses %>%
    filter(if_any(all_of(su_cols$habitat), \(x) !is.na(x) & x > 0)) %>%
    transmute(site_id, sample_date, protocol = "habitat",
              policy = data_policy_habitatcomplexity)
) %>%
  filter(policy %in% names(policy_codes))

# One row per site-day and protocol - what the app pairs
surveys <- survey_events %>%
  distinct(site_id, sample_date, protocol, .keep_all = TRUE)

#### Sites, projects and countries ####
# Data policy per site and protocol: 0 = not surveyed, 1 = public summary,
# 2 = public, 3 = private. Policies are set per project and protocol, so a site
# has one policy per protocol; max() would treat any mix as private.
site_policies <- surveys %>%
  mutate(protocol = factor(protocol, levels = names(protocols))) %>%
  group_by(site_id, protocol) %>%
  summarise(policy = max(policy_codes[policy]), .groups = "drop") %>%
  pivot_wider(names_from = protocol, values_from = policy,
              names_expand = TRUE, values_fill = 0L)

sites <- ses %>%
  filter(site_id %in% surveys$site_id) %>%
  distinct(site_id, .keep_all = TRUE) %>%
  select(site_id, site, project_id, project, country, latitude, longitude) %>%
  arrange(country, project, site) %>%
  left_join(site_policies, by = "site_id")

projects  <- sites %>% distinct(project_id, project) %>% arrange(project)
countries <- sort(unique(sites$country))

# Survey table with sites, protocols and dates as integers (0-based indices
# for JavaScript; dates as days since 1970-01-01)
survey_rows <- surveys %>%
  transmute(site     = match(site_id, sites$site_id) - 1L,
            protocol = match(protocol, names(protocols)) - 1L,
            day      = as.integer(sample_date)) %>%
  arrange(site, protocol, day)

#### Write the JSON ####
app_data <- list(
  meta = list(
    downloaded     = format(downloaded_on),
    exported       = format(Sys.Date()),
    protocols      = tibble(key = names(protocols), label = unname(protocols)),
    sample_events_public  = as.list(table(factor(
      survey_events$protocol[survey_events$policy != "private"],
      levels = names(protocols)))),
    sample_events_private = as.list(table(factor(
      survey_events$protocol[survey_events$policy == "private"],
      levels = names(protocols)))),
    policy_codes   = list(`0` = "not surveyed", `1` = "public summary",
                          `2` = "public", `3` = "private")
  ),
  countries = countries,
  projects  = list(id = projects$project_id, name = projects$project),
  sites = list(
    id      = sites$site_id,
    name    = sites$site,
    project = match(sites$project_id, projects$project_id) - 1L,
    country = match(sites$country, countries) - 1L,
    lat     = round(sites$latitude, 5),
    lon     = round(sites$longitude, 5),
    policy  = map(names(protocols), \(k) sites[[k]])
  ),
  surveys = as.list(survey_rows)
)

dir.create(dirname(out_path), showWarnings = FALSE, recursive = TRUE)
write_json(app_data, out_path, auto_unbox = TRUE, digits = NA, na = "null")

message("Wrote ", nrow(sites), " sites and ", nrow(survey_rows),
        " site-day surveys to docs/app/data/app_data.json (",
        round(file.size(out_path) / 1e6, 1), " MB)")
