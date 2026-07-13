/*
TheRun Races Overlay OBS source
Copyright (C) 2026 ramonchi5

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.
*/

#include "race-source.hpp"
#include "backend-manager.hpp"

#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>
#include <winhttp.h>

#include <obs-module.h>
#include <plugin-support.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <cwctype>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

using namespace Gdiplus;
using namespace std::chrono_literals;

namespace {

constexpr const char *SOURCE_ID = "therun_race_leaderboard";

constexpr const char *SETTING_BACKEND_URL = "backend_url";
constexpr const char *SETTING_AUTO_BACKEND = "auto_backend";
constexpr const char *SETTING_RACE_URL = "race_url";
constexpr const char *SETTING_WIDTH = "output_width";
constexpr const char *SETTING_ROW_HEIGHT = "row_height";
constexpr const char *SETTING_ROW_GAP = "row_gap";
constexpr const char *SETTING_SHOW_TITLE = "show_title";
constexpr const char *SETTING_TITLE_SIZE = "title_font_size";
constexpr const char *SETTING_FONT_FACE = "font_face";
constexpr const char *SETTING_FONT_SCALE = "font_scale";
constexpr const char *SETTING_RENDER_SCALE = "render_scale";
constexpr const char *SETTING_BACKGROUND_OPACITY = "background_opacity";
constexpr const char *SETTING_POSITION_OPACITY = "position_opacity";
constexpr const char *SETTING_GRADIENT_STRENGTH = "gradient_strength";
constexpr const char *SETTING_USE_GRADIENT = "use_gradient";
constexpr const char *SETTING_SHADOW_OFFSET = "shadow_offset";
constexpr const char *SETTING_SHADOW_BLUR = "shadow_blur";
constexpr const char *SETTING_SHADOW_OPACITY = "shadow_opacity";
constexpr const char *SETTING_OUTLINE_SIZE = "outline_size";
constexpr const char *SETTING_POLL_INTERVAL = "poll_interval";

constexpr uint32_t DEFAULT_WIDTH = 750;
constexpr uint32_t DEFAULT_ROW_HEIGHT = 110;
constexpr uint32_t DEFAULT_ROW_GAP = 3;

constexpr uint32_t DEFAULT_TITLE_SIZE = 32;
constexpr uint32_t DEFAULT_FONT_SCALE = 115;
constexpr uint32_t DEFAULT_RENDER_SCALE = 100;
constexpr uint32_t DEFAULT_BACKGROUND_OPACITY = 20;
constexpr uint32_t DEFAULT_POSITION_OPACITY = 75;
constexpr uint32_t DEFAULT_GRADIENT_STRENGTH = 100;
constexpr uint32_t DEFAULT_SHADOW_OFFSET = 4;
constexpr uint32_t DEFAULT_SHADOW_BLUR = 2;
constexpr uint32_t DEFAULT_SHADOW_OPACITY = 100;
constexpr float DEFAULT_OUTLINE_SIZE = 2.0f;
constexpr uint32_t DEFAULT_POLL_INTERVAL = 1000;

const Color COLOR_WHITE(255, 255, 255, 255);
const Color COLOR_GRAY(255, 218, 222, 218);
const Color COLOR_DARK(255, 64, 64, 64);
const Color COLOR_GREEN(255, 125, 255, 140);
const Color COLOR_RED(255, 255, 111, 111);
const Color COLOR_AMBER(255, 255, 190, 75);

template<typename T> T clamp_value(T value, T minimum, T maximum)
{
	return std::max(minimum, std::min(value, maximum));
}

std::string trim(std::string value)
{
	const auto first = value.find_first_not_of(" \t\r\n");
	if (first == std::string::npos)
		return {};

	const auto last = value.find_last_not_of(" \t\r\n");
	return value.substr(first, last - first + 1);
}

std::string lower_ascii(std::string value)
{
	std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
		return static_cast<char>(std::tolower(character));
	});
	return value;
}

bool contains_case_insensitive(const std::string &value, const std::string &needle)
{
	return lower_ascii(value).find(lower_ascii(needle)) != std::string::npos;
}

std::wstring utf8_to_wide(const std::string &value)
{
	if (value.empty())
		return {};

	const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(),
					 static_cast<int>(value.size()), nullptr, 0);
	if (length <= 0) {
		return std::wstring(value.begin(), value.end());
	}

	std::wstring result(static_cast<size_t>(length), L'\0');
	MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(), static_cast<int>(value.size()),
			    result.data(), length);
	return result;
}

std::wstring upper_wide(std::wstring value)
{
	std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character) {
		return static_cast<wchar_t>(std::towupper(character));
	});
	return value;
}

std::string normalize_race_id(std::string value)
{
	value = trim(std::move(value));
	if (value.empty())
		return {};

	const auto marker = value.find("/races/");
	if (marker != std::string::npos) {
		value = value.substr(marker + 7);
	}

	const auto stop = value.find_first_of("/?#");
	if (stop != std::string::npos)
		value.resize(stop);

	return trim(std::move(value));
}

std::string percent_encode(const std::string &value)
{
	static constexpr char HEX[] = "0123456789ABCDEF";
	std::string result;
	result.reserve(value.size() * 3);

	for (const unsigned char character : value) {
		if (std::isalnum(character) || character == '-' || character == '_' || character == '.' ||
		    character == '~') {
			result.push_back(static_cast<char>(character));
		} else {
			result.push_back('%');
			result.push_back(HEX[(character >> 4) & 0x0F]);
			result.push_back(HEX[character & 0x0F]);
		}
	}

	return result;
}

std::string get_string(obs_data_t *data, const char *name)
{
	const char *value = obs_data_get_string(data, name);
	return value ? value : "";
}

class WinHttpHandle {
public:
	WinHttpHandle() = default;
	explicit WinHttpHandle(HINTERNET value) : value_(value) {}
	~WinHttpHandle()
	{
		if (value_)
			WinHttpCloseHandle(value_);
	}

	WinHttpHandle(const WinHttpHandle &) = delete;
	WinHttpHandle &operator=(const WinHttpHandle &) = delete;

	WinHttpHandle(WinHttpHandle &&other) noexcept : value_(std::exchange(other.value_, nullptr)) {}
	WinHttpHandle &operator=(WinHttpHandle &&other) noexcept
	{
		if (this != &other) {
			if (value_)
				WinHttpCloseHandle(value_);
			value_ = std::exchange(other.value_, nullptr);
		}
		return *this;
	}

	operator HINTERNET() const { return value_; }
	explicit operator bool() const { return value_ != nullptr; }

private:
	HINTERNET value_ = nullptr;
};

[[noreturn]] void throw_http_error(const char *operation)
{
	throw std::runtime_error(std::string(operation) + " failed with Windows error " +
				 std::to_string(GetLastError()));
}

std::string http_get_json(const std::string &url)
{
	const std::wstring wide_url = utf8_to_wide(url);
	URL_COMPONENTS components{};
	components.dwStructSize = sizeof(components);
	components.dwSchemeLength = static_cast<DWORD>(-1);
	components.dwHostNameLength = static_cast<DWORD>(-1);
	components.dwUrlPathLength = static_cast<DWORD>(-1);
	components.dwExtraInfoLength = static_cast<DWORD>(-1);

	if (!WinHttpCrackUrl(wide_url.c_str(), 0, 0, &components))
		throw_http_error("WinHttpCrackUrl");

	const std::wstring host(components.lpszHostName, components.dwHostNameLength);
	std::wstring path(components.lpszUrlPath, components.dwUrlPathLength);
	if (components.dwExtraInfoLength > 0)
		path.append(components.lpszExtraInfo, components.dwExtraInfoLength);
	if (path.empty())
		path = L"/";

	WinHttpHandle session(WinHttpOpen(L"TheRunRacesOverlay-OBS/3.2.3",
					  WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
					  WINHTTP_NO_PROXY_BYPASS, 0));
	if (!session)
		throw_http_error("WinHttpOpen");

	WinHttpSetTimeouts(session, 3000, 3000, 5000, 10000);

	WinHttpHandle connection(WinHttpConnect(session, host.c_str(), components.nPort, 0));
	if (!connection)
		throw_http_error("WinHttpConnect");

	const DWORD flags = components.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0;
	WinHttpHandle request(WinHttpOpenRequest(connection, L"GET", path.c_str(), nullptr,
						 WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags));
	if (!request)
		throw_http_error("WinHttpOpenRequest");

	const wchar_t *headers = L"Accept: application/json\r\nCache-Control: no-cache\r\n";
	if (!WinHttpSendRequest(request, headers, static_cast<DWORD>(-1), WINHTTP_NO_REQUEST_DATA, 0, 0, 0))
		throw_http_error("WinHttpSendRequest");
	if (!WinHttpReceiveResponse(request, nullptr))
		throw_http_error("WinHttpReceiveResponse");

	DWORD status_code = 0;
	DWORD status_size = sizeof(status_code);
	if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
				 nullptr, &status_code, &status_size, nullptr)) {
		throw_http_error("WinHttpQueryHeaders");
	}

	std::string response;
	for (;;) {
		DWORD available = 0;
		if (!WinHttpQueryDataAvailable(request, &available))
			throw_http_error("WinHttpQueryDataAvailable");
		if (available == 0)
			break;

		const size_t offset = response.size();
		response.resize(offset + available);
		DWORD read = 0;
		if (!WinHttpReadData(request, response.data() + offset, available, &read))
			throw_http_error("WinHttpReadData");
		response.resize(offset + read);
	}

	if (status_code < 200 || status_code >= 300) {
		throw std::runtime_error("Local backend returned HTTP " + std::to_string(status_code));
	}

	return response;
}

struct SourceSettings {
	std::string backend_url = "http://127.0.0.1:5179";
	std::string race_url;
	std::wstring font_face = L"Segoe UI";
	uint32_t width = DEFAULT_WIDTH;
	uint32_t row_height = DEFAULT_ROW_HEIGHT;
	uint32_t row_gap = DEFAULT_ROW_GAP;
	uint32_t title_size = DEFAULT_TITLE_SIZE;
	uint32_t font_scale = DEFAULT_FONT_SCALE;
	uint32_t render_scale = DEFAULT_RENDER_SCALE;
	uint32_t background_opacity = DEFAULT_BACKGROUND_OPACITY;
	uint32_t position_opacity = DEFAULT_POSITION_OPACITY;
	uint32_t gradient_strength = DEFAULT_GRADIENT_STRENGTH;
	uint32_t shadow_offset = DEFAULT_SHADOW_OFFSET;
	uint32_t shadow_blur = DEFAULT_SHADOW_BLUR;
	uint32_t shadow_opacity = DEFAULT_SHADOW_OPACITY;
	uint32_t poll_interval = DEFAULT_POLL_INTERVAL;
	float outline_size = DEFAULT_OUTLINE_SIZE;
	bool auto_backend = true;
	bool show_title = true;
};

bool uses_managed_backend(const SourceSettings &settings)
{
	if (!settings.auto_backend)
		return false;
	const std::string url = lower_ascii(settings.backend_url);
	return url == "http://127.0.0.1:5179" || url == "http://localhost:5179";
}

struct LatestSplit {
	std::string name;
	std::string time;
	std::string percent;
	bool present = false;
};

struct RunnerData {
	std::string place;
	std::string username;
	std::string rating;
	std::string rating_delta;
	std::string percent;
	std::string status;
	std::string current_time;
	std::string race_delta;
	std::string confirmation_status;
	std::string disqualification_reason;
	LatestSplit latest_split;
	int64_t race_delta_ms = 0;
	int64_t planned_splits = 0;
	int64_t completed_splits = 0;
	bool streaming = false;
	bool disqualified = false;
	bool comparison_baseline = false;
	bool finished = false;
	bool abandoned = false;
	bool ready = false;
	bool not_ready = false;
};

struct RaceData {
	std::string race_id;
	std::string category;
	std::string race_status;
	std::string stale_reason;
	std::vector<RunnerData> runners;
	int64_t progress_current = 0;
	int64_t progress_total = 0;
	bool stale = false;
};

RaceData parse_race_data(const std::string &json)
{
	obs_data_t *root = obs_data_create_from_json(json.c_str());
	if (!root)
		throw std::runtime_error("The local backend returned invalid JSON");

	std::unique_ptr<obs_data_t, decltype(&obs_data_release)> root_guard(root, obs_data_release);
	if (!obs_data_get_bool(root, "ok")) {
		const std::string error = get_string(root, "error");
		throw std::runtime_error(error.empty() ? "The local backend rejected the race" : error);
	}

	RaceData race;
	race.race_id = get_string(root, "raceId");
	race.category = get_string(root, "category");
	race.race_status = get_string(root, "raceStatus");
	race.stale = obs_data_get_bool(root, "stale");
	race.stale_reason = get_string(root, "staleReason");

	obs_data_array_t *array = obs_data_get_array(root, "runners");
	if (!array)
		return race;

	std::unique_ptr<obs_data_array_t, decltype(&obs_data_array_release)> array_guard(
		array, obs_data_array_release);
	const size_t count = obs_data_array_count(array);
	race.runners.reserve(count);

	for (size_t index = 0; index < count; ++index) {
		obs_data_t *item = obs_data_array_item(array, index);
		if (!item)
			continue;

		std::unique_ptr<obs_data_t, decltype(&obs_data_release)> item_guard(item, obs_data_release);
		RunnerData runner;
		runner.place = get_string(item, "place");
		runner.username = get_string(item, "username");
		runner.rating = get_string(item, "rating");
		runner.rating_delta = get_string(item, "ratingDelta");
		runner.percent = get_string(item, "percent");
		runner.status = get_string(item, "status");
		runner.current_time = get_string(item, "currentTime");
		runner.race_delta = get_string(item, "raceDelta");
		runner.confirmation_status = get_string(item, "confirmationStatus");
		runner.disqualification_reason = get_string(item, "disqualificationReason");
		runner.race_delta_ms = obs_data_get_int(item, "raceDeltaMs");
		runner.planned_splits = obs_data_get_int(item, "plannedMainSplitCount");
		runner.completed_splits = obs_data_get_int(item, "completedMainSplitCount");
		runner.streaming = obs_data_get_bool(item, "streaming");
		runner.disqualified = obs_data_get_bool(item, "isDisqualified") ||
				      contains_case_insensitive(runner.status, "disqual") ||
				      contains_case_insensitive(runner.status, "dsq");
		runner.abandoned = runner.disqualified || contains_case_insensitive(runner.status, "abandoned");
		runner.finished = !runner.abandoned && contains_case_insensitive(runner.status, "done");
		runner.comparison_baseline = obs_data_get_bool(item, "isComparisonBaseline");

		obs_data_t *latest = obs_data_get_obj(item, "latestSplit");
		if (latest) {
			std::unique_ptr<obs_data_t, decltype(&obs_data_release)> latest_guard(latest,
										obs_data_release);
			runner.latest_split.name = get_string(latest, "name");
			runner.latest_split.time = get_string(latest, "time");
			runner.latest_split.percent = get_string(latest, "percent");
			runner.latest_split.present = !runner.latest_split.name.empty() ||
						      !runner.latest_split.time.empty();
		}

		runner.ready = !runner.latest_split.present && lower_ascii(runner.status) == "ready";
		runner.not_ready = !runner.latest_split.present && lower_ascii(runner.status) == "not ready";
		if (!runner.finished && !runner.abandoned && runner.confirmation_status.size() > 0 &&
		    runner.completed_splits >= runner.planned_splits && runner.planned_splits > 0) {
			runner.finished = true;
		}

		race.runners.push_back(std::move(runner));
	}

	const RunnerData *progress_runner = nullptr;
	for (const RunnerData &runner : race.runners) {
		if (runner.comparison_baseline && runner.planned_splits > 0) {
			progress_runner = &runner;
			break;
		}
	}
	if (!progress_runner) {
		for (const RunnerData &runner : race.runners) {
			if (runner.planned_splits > 0) {
				progress_runner = &runner;
				break;
			}
		}
	}
	if (progress_runner) {
		race.progress_current = progress_runner->completed_splits;
		race.progress_total = progress_runner->planned_splits;
	}

	return race;
}

struct RenderFrame {
	uint32_t width = 0;
	uint32_t height = 0;
	uint32_t texture_width = 0;
	uint32_t texture_height = 0;
	uint32_t stride = 0;
	std::vector<uint8_t> pixels;
};

Color mix_color(const Color &first, const Color &second, float amount)
{
	const float clamped = clamp_value(amount, 0.0f, 1.0f);
	auto mix_channel = [clamped](BYTE a, BYTE b) {
		return static_cast<BYTE>(std::lround(static_cast<float>(a) +
					       (static_cast<float>(b) - static_cast<float>(a)) * clamped));
	};

	return Color(mix_channel(first.GetA(), second.GetA()), mix_channel(first.GetR(), second.GetR()),
		     mix_channel(first.GetG(), second.GetG()), mix_channel(first.GetB(), second.GetB()));
}

class TextPainter {
public:
	TextPainter(Graphics &graphics, const SourceSettings &settings)
		: graphics_(graphics), settings_(settings),
		  family_(std::make_unique<FontFamily>(settings.font_face.c_str()))
	{
		if (family_->GetLastStatus() != Ok)
			family_ = std::make_unique<FontFamily>(L"Segoe UI");
	}

	RectF measure_bounds(const std::wstring &text, float size, INT style) const
	{
		if (text.empty())
			return {};

		GraphicsPath path;
		StringFormat format;
		format.SetFormatFlags(StringFormatFlagsNoClip | StringFormatFlagsMeasureTrailingSpaces);
		path.AddString(text.c_str(), static_cast<INT>(text.size()), family_.get(), style, size,
			       PointF(0.0f, 0.0f), &format);
		RectF bounds;
		path.GetBounds(&bounds);
		return bounds;
	}

	float measure_width(const std::wstring &text, float size, INT style) const
	{
		return measure_bounds(text, size, style).Width;
	}

	std::wstring fit_text(const std::wstring &text, float size, INT style, float maximum_width) const
	{
		if (text.empty() || measure_width(text, size, style) <= maximum_width)
			return text;

		size_t low = 0;
		size_t high = text.size();
		while (low < high) {
			const size_t middle = (low + high + 1) / 2;
			if (measure_width(text.substr(0, middle), size, style) <= maximum_width)
				low = middle;
			else
				high = middle - 1;
		}

		return text.substr(0, low);
	}

	float draw(const std::wstring &text, float x, float y, float size, INT style,
		   const Color &semantic_color, bool gradient, float shadow_multiplier = 1.0f)
	{
		if (text.empty())
			return 0.0f;

		GraphicsPath path;
		StringFormat format;
		format.SetFormatFlags(StringFormatFlagsNoClip | StringFormatFlagsMeasureTrailingSpaces);
		path.AddString(text.c_str(), static_cast<INT>(text.size()), family_.get(), style, size,
			       PointF(x, y), &format);

		RectF bounds;
		path.GetBounds(&bounds);
		draw_shadow(path, shadow_multiplier);

		if (settings_.outline_size > 0.0f) {
			Pen outline(Color(150, 0, 0, 0), settings_.outline_size);
			outline.SetLineJoin(LineJoinRound);
			graphics_.DrawPath(&outline, &path);
		}

		if (gradient && settings_.gradient_strength > 0 && bounds.Height > 0.5f) {
			const float amount = static_cast<float>(settings_.gradient_strength) / 100.0f;
			const float smooth_amount = amount * amount * (3.0f - 2.0f * amount);
			const float transition_span = 0.08f + 0.40f * smooth_amount;
			const float edge_mix = clamp_value(amount / 0.12f, 0.0f, 1.0f);
			const Color top_edge = mix_color(semantic_color, COLOR_WHITE, edge_mix);
			const Color bottom_edge = mix_color(semantic_color, COLOR_DARK, edge_mix);
			const float gradient_padding = std::max(1.0f, size * 0.035f);
			const PointF top(bounds.X, bounds.Y - gradient_padding);
			const PointF bottom(bounds.X, bounds.GetBottom() + gradient_padding);
			LinearGradientBrush brush(top, bottom, top_edge, bottom_edge);
			Color colors[] = {
				top_edge,
				mix_color(top_edge, semantic_color, 0.55f),
				semantic_color,
				semantic_color,
				mix_color(semantic_color, bottom_edge, 0.45f),
				bottom_edge,
			};
			REAL positions[] = {
				0.0f,
				transition_span * 0.45f,
				transition_span,
				1.0f - transition_span,
				1.0f - transition_span * 0.45f,
				1.0f,
			};
			brush.SetWrapMode(WrapModeClamp);
			brush.SetInterpolationColors(colors, positions, 6);
			graphics_.FillPath(&brush, &path);
		} else {
			SolidBrush brush(semantic_color);
			graphics_.FillPath(&brush, &path);
		}

		return bounds.Width;
	}

	void draw_centered(const std::wstring &text, float center_x, float y, float size, INT style,
			   const Color &color, bool gradient)
	{
		const RectF bounds = measure_bounds(text, size, style);
		draw(text, center_x - bounds.X - bounds.Width * 0.5f, y, size, style, color, gradient);
	}

	void draw_centered_in(const std::wstring &text, const RectF &area, float size, INT style,
			      const Color &color, bool gradient)
	{
		const RectF bounds = measure_bounds(text, size, style);
		const float x = area.X + (area.Width - bounds.Width) * 0.5f - bounds.X;
		const float y = area.Y + (area.Height - bounds.Height) * 0.5f - bounds.Y;
		draw(text, x, y, size, style, color, gradient);
	}

	void draw_right(const std::wstring &text, float right, float y, float size, INT style,
			const Color &color, bool gradient)
	{
		const RectF bounds = measure_bounds(text, size, style);
		draw(text, right - bounds.X - bounds.Width, y, size, style, color, gradient);
	}

private:
	void draw_shadow(const GraphicsPath &path, float multiplier)
	{
		const float offset = static_cast<float>(settings_.shadow_offset) * multiplier;
		const float blur = static_cast<float>(settings_.shadow_blur) * multiplier;
		const BYTE opacity = static_cast<BYTE>(std::lround(
			255.0f * static_cast<float>(settings_.shadow_opacity) / 100.0f));
		if (opacity == 0)
			return;

		struct Sample {
			float x;
			float y;
			float alpha;
		};
		static constexpr std::array<Sample, 13> samples = {{
			{0.0f, 0.0f, 0.74f},
			{-0.5f, 0.0f, 0.24f},
			{0.5f, 0.0f, 0.24f},
			{0.0f, -0.5f, 0.24f},
			{0.0f, 0.5f, 0.24f},
			{-0.5f, -0.5f, 0.16f},
			{0.5f, -0.5f, 0.16f},
			{-0.5f, 0.5f, 0.16f},
			{0.5f, 0.5f, 0.16f},
			{-1.0f, 0.0f, 0.08f},
			{1.0f, 0.0f, 0.08f},
			{0.0f, -1.0f, 0.08f},
			{0.0f, 1.0f, 0.08f},
		}};

		for (const Sample &sample : samples) {
			const BYTE alpha = static_cast<BYTE>(std::lround(
				static_cast<float>(opacity) * sample.alpha));
			SolidBrush shadow(Color(alpha, 0, 0, 0));
			const GraphicsState state = graphics_.Save();
			graphics_.TranslateTransform(offset + sample.x * blur, offset + sample.y * blur);
			graphics_.FillPath(&shadow, &path);
			graphics_.Restore(state);
		}
	}

	Graphics &graphics_;
	const SourceSettings &settings_;
	std::unique_ptr<FontFamily> family_;
};

std::vector<std::wstring> wrap_text(TextPainter &painter, const std::wstring &text, float size,
				    INT style, float maximum_width)
{
	std::vector<std::wstring> words;
	std::wstring current_word;
	for (const wchar_t character : text) {
		if (std::iswspace(character)) {
			if (!current_word.empty()) {
				words.push_back(current_word);
				current_word.clear();
			}
		} else {
			current_word.push_back(character);
		}
	}
	if (!current_word.empty())
		words.push_back(current_word);

	std::vector<std::wstring> lines;
	std::wstring line;
	for (const std::wstring &word : words) {
		const std::wstring candidate = line.empty() ? word : line + L" " + word;
		if (painter.measure_width(candidate, size, style) <= maximum_width) {
			line = candidate;
			continue;
		}

		if (!line.empty()) {
			lines.push_back(line);
			line.clear();
		}

		if (painter.measure_width(word, size, style) <= maximum_width) {
			line = word;
			continue;
		}

		std::wstring fragment;
		for (const wchar_t character : word) {
			const std::wstring next = fragment + character;
			if (!fragment.empty() && painter.measure_width(next, size, style) > maximum_width) {
				lines.push_back(fragment);
				fragment.assign(1, character);
			} else {
				fragment = next;
			}
		}
		line = fragment;
	}

	if (!line.empty())
		lines.push_back(line);
	if (lines.empty())
		lines.emplace_back();
	return lines;
}

std::string normalized_place(const RunnerData &runner)
{
	if (runner.disqualified)
		return "-";
	std::string place = trim(runner.place);
	if (place.empty() || place == "-")
		return "-";
	if (place.front() != '#')
		place.insert(place.begin(), '#');
	return place;
}

void draw_live_dot(Graphics &graphics, float center_x, float center_y, float radius,
		   const SourceSettings &settings)
{
	const float offset = static_cast<float>(settings.shadow_offset);
	const float blur = static_cast<float>(settings.shadow_blur);
	const BYTE shadow_alpha = static_cast<BYTE>(std::lround(
		255.0f * static_cast<float>(settings.shadow_opacity) / 100.0f));
	SolidBrush outer_shadow(Color(static_cast<BYTE>(shadow_alpha * 0.35f), 0, 0, 0));
	graphics.FillEllipse(&outer_shadow, center_x - radius + offset - blur * 0.5f,
			     center_y - radius + offset - blur * 0.5f, radius * 2.0f + blur,
			     radius * 2.0f + blur);
	SolidBrush core_shadow(Color(shadow_alpha, 0, 0, 0));
	graphics.FillEllipse(&core_shadow, center_x - radius + offset, center_y - radius + offset,
			     radius * 2.0f, radius * 2.0f);

	const Color live_red(255, 255, 69, 69);
	if (settings.gradient_strength > 0) {
		const float amount = static_cast<float>(settings.gradient_strength) / 100.0f;
		const float smooth_amount = amount * amount * (3.0f - 2.0f * amount);
		const float transition_span = 0.08f + 0.40f * smooth_amount;
		const float edge_mix = clamp_value(amount / 0.12f, 0.0f, 1.0f);
		const Color top_edge = mix_color(live_red, COLOR_WHITE, edge_mix);
		const Color bottom_edge = mix_color(live_red, COLOR_DARK, edge_mix);
		const float gradient_padding = std::max(0.75f, radius * 0.12f);
		LinearGradientBrush brush(PointF(center_x, center_y - radius - gradient_padding),
					  PointF(center_x, center_y + radius + gradient_padding), top_edge,
					  bottom_edge);
		Color colors[] = {
			top_edge,
			mix_color(top_edge, live_red, 0.55f),
			live_red,
			live_red,
			mix_color(live_red, bottom_edge, 0.45f),
			bottom_edge,
		};
		REAL positions[] = {
			0.0f,
			transition_span * 0.45f,
			transition_span,
			1.0f - transition_span,
			1.0f - transition_span * 0.45f,
			1.0f,
		};
		brush.SetWrapMode(WrapModeClamp);
		brush.SetInterpolationColors(colors, positions, 6);
		graphics.FillEllipse(&brush, center_x - radius, center_y - radius, radius * 2.0f,
				     radius * 2.0f);
	} else {
		SolidBrush brush(live_red);
		graphics.FillEllipse(&brush, center_x - radius, center_y - radius, radius * 2.0f,
				     radius * 2.0f);
	}
}

float render_scale_for(const SourceSettings &settings, uint32_t width, uint32_t height)
{
	constexpr float MAX_SCALE = 3.0f;
	constexpr float MAX_TEXTURE_DIMENSION = 8192.0f;
	constexpr double MAX_TEXTURE_PIXELS = 32.0 * 1024.0 * 1024.0;
	const float requested = clamp_value(static_cast<float>(settings.render_scale) / 100.0f,
					    1.0f, MAX_SCALE);
	const float dimension_limit = std::min(MAX_TEXTURE_DIMENSION / static_cast<float>(width),
					       MAX_TEXTURE_DIMENSION / static_cast<float>(height));
	const float pixel_limit = static_cast<float>(std::sqrt(
		MAX_TEXTURE_PIXELS / (static_cast<double>(width) * static_cast<double>(height))));
	return std::max(1.0f, std::min({requested, dimension_limit, pixel_limit}));
}

RenderFrame copy_bitmap(Bitmap &bitmap, uint32_t width, uint32_t height, uint32_t texture_width,
			uint32_t texture_height)
{
	RenderFrame frame;
	frame.width = width;
	frame.height = height;
	frame.texture_width = texture_width;
	frame.texture_height = texture_height;
	frame.stride = texture_width * 4;
	frame.pixels.resize(static_cast<size_t>(frame.stride) * texture_height);

	BitmapData data{};
	Rect rectangle(0, 0, static_cast<INT>(texture_width), static_cast<INT>(texture_height));
	if (bitmap.LockBits(&rectangle, ImageLockModeRead, PixelFormat32bppPARGB, &data) != Ok)
		throw std::runtime_error("GDI+ could not read the rendered leaderboard");

	const auto *scan = static_cast<const uint8_t *>(data.Scan0);
	const INT source_stride = data.Stride;
	for (uint32_t row = 0; row < texture_height; ++row) {
		const uint32_t source_row = source_stride < 0 ? texture_height - row - 1 : row;
		const auto *source = scan + static_cast<ptrdiff_t>(source_row) * std::abs(source_stride);
		auto *destination = frame.pixels.data() + static_cast<size_t>(row) * frame.stride;
		std::memcpy(destination, source, frame.stride);
	}

	bitmap.UnlockBits(&data);
	return frame;
}

RenderFrame render_message(const SourceSettings &settings, const std::string &message)
{
	const uint32_t width = settings.width;
	const uint32_t height = 180;
	const float render_scale = render_scale_for(settings, width, height);
	const uint32_t texture_width = static_cast<uint32_t>(std::ceil(width * render_scale));
	const uint32_t texture_height = static_cast<uint32_t>(std::ceil(height * render_scale));
	Bitmap bitmap(static_cast<INT>(texture_width), static_cast<INT>(texture_height),
		      PixelFormat32bppPARGB);
	Graphics graphics(&bitmap);
	graphics.SetSmoothingMode(SmoothingModeAntiAlias);
	graphics.SetCompositingQuality(CompositingQualityHighQuality);
	graphics.SetPixelOffsetMode(PixelOffsetModeHighQuality);
	graphics.Clear(Color(0, 0, 0, 0));
	graphics.ScaleTransform(render_scale, render_scale);

	SolidBrush background(Color(178, 7, 9, 11));
	graphics.FillRectangle(&background, 0.0f, 20.0f, static_cast<float>(width), 130.0f);
	TextPainter painter(graphics, settings);
	const float text_size = 30.0f * static_cast<float>(settings.font_scale) / 100.0f;
	painter.draw_centered(utf8_to_wide(message), static_cast<float>(width) * 0.5f, 65.0f, text_size,
			      FontStyleBold, COLOR_WHITE, true);
	return copy_bitmap(bitmap, width, height, texture_width, texture_height);
}

RenderFrame render_race(const RaceData &race, const SourceSettings &settings,
			const std::unordered_set<std::string> &highlighted)
{
	const float scale = static_cast<float>(settings.font_scale) / 100.0f;
	const float width = static_cast<float>(settings.width);
	const float title_size = static_cast<float>(settings.title_size) * scale;
	const float progress_size = 20.0f * scale;

	Bitmap measuring_bitmap(8, 8, PixelFormat32bppARGB);
	Graphics measuring_graphics(&measuring_bitmap);
	TextPainter measuring_painter(measuring_graphics, settings);
	const std::wstring title = upper_wide(utf8_to_wide(race.category.empty() ? "RACE" : race.category + " Race"));
	const auto title_lines = wrap_text(measuring_painter, title, title_size, FontStyleBold, width - 80.0f);

	float title_height = 0.0f;
	if (settings.show_title) {
		title_height = 22.0f + static_cast<float>(title_lines.size()) * title_size * 1.13f;
		if (race.progress_total > 0)
			title_height += progress_size + 13.0f;
		title_height += 16.0f;
	}

	const float rows_height = race.runners.empty()
				  ? static_cast<float>(settings.row_height)
				  : static_cast<float>(race.runners.size() * settings.row_height +
						 (race.runners.size() - 1) * settings.row_gap);
	const uint32_t output_height = static_cast<uint32_t>(std::ceil(title_height + rows_height));
	const float render_scale = render_scale_for(settings, settings.width, output_height);
	const uint32_t texture_width = static_cast<uint32_t>(std::ceil(settings.width * render_scale));
	const uint32_t texture_height = static_cast<uint32_t>(std::ceil(output_height * render_scale));
	Bitmap bitmap(static_cast<INT>(texture_width), static_cast<INT>(texture_height),
		      PixelFormat32bppPARGB);
	Graphics graphics(&bitmap);
	graphics.SetSmoothingMode(SmoothingModeAntiAlias);
	graphics.SetCompositingQuality(CompositingQualityHighQuality);
	graphics.SetPixelOffsetMode(PixelOffsetModeHighQuality);
	graphics.SetInterpolationMode(InterpolationModeHighQualityBicubic);
	graphics.Clear(Color(0, 0, 0, 0));
	graphics.ScaleTransform(render_scale, render_scale);
	TextPainter painter(graphics, settings);

	float cursor_y = 0.0f;
	if (settings.show_title) {
		cursor_y = 22.0f;
		for (const std::wstring &line : title_lines) {
			painter.draw_centered(line, width * 0.5f, cursor_y, title_size, FontStyleBold,
					      COLOR_WHITE, true);
			cursor_y += title_size * 1.13f;
		}
		if (race.progress_total > 0) {
			const std::wstring progress = L"SPLIT " + std::to_wstring(race.progress_current) + L"/" +
						      std::to_wstring(race.progress_total);
			painter.draw_centered(progress, width * 0.5f, cursor_y + 3.0f, progress_size,
					      FontStyleBold, COLOR_GRAY, true);
			cursor_y += progress_size + 13.0f;
		}
		cursor_y += 16.0f;
	}

	if (race.stale) {
		SolidBrush warning_shadow(Color(180, 0, 0, 0));
		graphics.FillEllipse(&warning_shadow, width - 27.0f, 13.0f, 14.0f, 14.0f);
		SolidBrush warning(COLOR_AMBER);
		graphics.FillEllipse(&warning, width - 29.0f, 11.0f, 14.0f, 14.0f);
	}

	if (race.runners.empty()) {
		const float outer_padding = std::max(10.0f, width * 0.012f);
		SolidBrush background(Color(178, 7, 9, 11));
		graphics.FillRectangle(&background, outer_padding, cursor_y, width - outer_padding * 2.0f,
				       static_cast<float>(settings.row_height));
		painter.draw_centered(L"WAITING FOR RUNNERS", width * 0.5f, cursor_y + 35.0f,
				      30.0f * scale, FontStyleBold, COLOR_GRAY, true);
		return copy_bitmap(bitmap, settings.width, output_height, texture_width, texture_height);
	}

	const float outer_padding = std::max(10.0f, width * 0.012f);
	const float row_left = outer_padding;
	const float row_width = width - outer_padding * 2.0f;
	const float place_width = std::max(82.0f, row_width * 0.11f);
	const float horizontal_padding = std::max(18.0f * scale, row_width * 0.018f);
	const float info_x = row_left + place_width + horizontal_padding;
	const float stats_left = row_left + row_width * 0.61f;
	const float stats_right = row_left + row_width - horizontal_padding;
	const BYTE row_alpha = static_cast<BYTE>(std::lround(255.0f * settings.background_opacity / 100.0f));
	const BYTE place_alpha = static_cast<BYTE>(std::lround(255.0f * settings.position_opacity / 100.0f));

	const float name_size = 36.0f * scale;
	const float rating_size = 20.0f * scale;
	const float secondary_size = 24.0f * scale;
	const float place_size = 28.0f * scale;
	const float time_size_default = 34.0f * scale;

	for (size_t index = 0; index < race.runners.size(); ++index) {
		const RunnerData &runner = race.runners[index];
		const float row_top = cursor_y + static_cast<float>(index * (settings.row_height + settings.row_gap));
		const float row_height = static_cast<float>(settings.row_height);

		SolidBrush row_background(Color(row_alpha, 7, 9, 11));
		graphics.FillRectangle(&row_background, row_left, row_top, row_width, row_height);
		SolidBrush place_background(Color(place_alpha, 72, 78, 74));
		graphics.FillRectangle(&place_background, row_left, row_top, place_width, row_height);
		if (highlighted.contains(runner.username)) {
			SolidBrush highlight(Color(42, 83, 220, 107));
			graphics.FillRectangle(&highlight, row_left + place_width, row_top,
					       row_width - place_width, row_height);
		}

		const std::wstring place = utf8_to_wide(normalized_place(runner));
		painter.draw_centered_in(place, RectF(row_left, row_top, place_width, row_height), place_size,
					 FontStyleBold, COLOR_WHITE, true);

		const float name_x = info_x;
		const float name_y = row_top + row_height * 0.12f;
		if (runner.streaming) {
			const float radius = std::max(4.5f, 5.5f * scale);
			draw_live_dot(graphics, name_x - radius - 3.0f * scale,
				      name_y + radius + 1.0f * scale, radius, settings);
		}

		const std::wstring rating = utf8_to_wide(runner.rating);
		const std::wstring rating_delta = utf8_to_wide(runner.rating_delta);
		const float rating_width = painter.measure_width(rating, rating_size, FontStyleRegular);
		const float rating_delta_width = painter.measure_width(rating_delta, rating_size, FontStyleRegular);
		const float rating_group_width = rating_width + rating_delta_width +
					 (rating.empty() || rating_delta.empty() ? 0.0f : 7.0f);
		const float available_name_width = std::max(24.0f, stats_left - name_x - rating_group_width - 16.0f);
		const std::wstring display_name = painter.fit_text(utf8_to_wide(runner.username), name_size,
								      FontStyleBold, available_name_width);
		const float name_width = painter.draw(display_name, name_x, name_y, name_size, FontStyleBold,
							 COLOR_WHITE, true);

		float rating_x = name_x + name_width + 10.0f;
		if (!rating.empty()) {
			painter.draw(rating, rating_x, name_y - 2.0f, rating_size, FontStyleRegular,
				     COLOR_WHITE, false, 0.7f);
			rating_x += rating_width + 7.0f;
		}
		if (!rating_delta.empty()) {
			const Color delta_color = rating_delta.front() == L'-' ? COLOR_RED : COLOR_GREEN;
			painter.draw(rating_delta, rating_x, name_y - 2.0f, rating_size, FontStyleRegular,
				     delta_color, false, 0.7f);
		}

		const float detail_y = row_top + row_height * 0.56f;
		const float detail_width = stats_left - info_x - 12.0f;
		if (runner.finished || runner.abandoned || runner.ready || runner.not_ready) {
			std::wstring label;
			Color label_color = COLOR_GREEN;
			if (runner.disqualified) {
				label = L"Disqualified";
				label_color = COLOR_RED;
			} else if (runner.abandoned) {
				label = L"Abandoned";
				label_color = COLOR_RED;
			} else if (runner.ready) {
				label = L"Ready";
			} else if (runner.not_ready) {
				label = L"Not Ready";
				label_color = COLOR_RED;
			} else {
				label = L"Finished";
			}

			const float label_width = painter.draw(label, info_x, detail_y, secondary_size,
							      FontStyleBold | FontStyleItalic, label_color, true);
			std::wstring confirmation;
			if (runner.disqualified) {
				confirmation = L"(" + utf8_to_wide(runner.disqualification_reason.empty()
									       ? "no reason given"
									       : runner.disqualification_reason) +
					       L")";
			} else if (runner.finished) {
				confirmation = runner.confirmation_status == "confirmed"
						       ? L"(confirmed)"
						       : L"(waiting for confirmation)";
			}

			if (!confirmation.empty()) {
				const float confirmation_x = info_x + label_width + 10.0f;
				const float remaining = std::max(0.0f, detail_width - label_width - 10.0f);
				confirmation = painter.fit_text(confirmation, secondary_size, FontStyleBold | FontStyleItalic,
								remaining);
				painter.draw(confirmation, confirmation_x, detail_y, secondary_size,
					     FontStyleBold | FontStyleItalic, COLOR_GRAY, true);
			}
		} else {
			std::string percent = runner.percent;
			if ((percent.empty() || percent == "-") && runner.latest_split.present)
				percent = runner.latest_split.percent;
			if (percent.empty())
				percent = "-";

			const float percent_slot = 84.0f * scale;
			painter.draw(utf8_to_wide(percent), info_x, detail_y, secondary_size,
				     FontStyleBold | FontStyleItalic, COLOR_GREEN, true);
			std::string detail = "No split yet";
			if (runner.latest_split.present) {
				detail = runner.latest_split.time + " at " + runner.latest_split.name;
			}
			const float split_x = info_x + percent_slot;
			const std::wstring split_text = painter.fit_text(utf8_to_wide(detail), secondary_size,
								       FontStyleBold | FontStyleItalic,
								       std::max(0.0f, detail_width - percent_slot));
			painter.draw(split_text, split_x, detail_y, secondary_size,
				     FontStyleBold | FontStyleItalic, COLOR_GRAY, true);
		}

		std::wstring current_time = utf8_to_wide(runner.current_time.empty() ? "-" : runner.current_time);
		const Color current_color = runner.abandoned ? COLOR_RED : COLOR_WHITE;
		std::wstring delta_label;
		Color delta_color = COLOR_GRAY;
		float delta_size = time_size_default;
		if (runner.abandoned) {
			delta_label = L"-";
		} else if (!runner.race_delta.empty()) {
			delta_label = utf8_to_wide(runner.race_delta);
			delta_color = runner.race_delta_ms < 0 ? COLOR_GREEN : COLOR_RED;
		} else if (runner.comparison_baseline) {
			delta_label = L"LEADER";
			delta_color = COLOR_GREEN;
		} else {
			delta_label = L"-";
		}

		float time_size = time_size_default;
		float time_width = painter.measure_width(current_time, time_size, FontStyleBold);
		float delta_width = painter.measure_width(delta_label, delta_size, FontStyleBold);
		const float delta_time_gap = (runner.abandoned ? 36.0f : 18.0f) * scale;
		const float stats_available = stats_right - stats_left;
		while (time_size > 18.0f * scale &&
		       time_width + delta_width + delta_time_gap > stats_available) {
			time_size -= 1.0f;
			delta_size = std::min(delta_size, time_size);
			time_width = painter.measure_width(current_time, time_size, FontStyleBold);
			delta_width = painter.measure_width(delta_label, delta_size, FontStyleBold);
		}

		const float stats_y = row_top + (row_height - time_size) * 0.42f;
		const float time_x = stats_right - time_width;
		painter.draw(current_time, time_x, stats_y, time_size, FontStyleBold, current_color, true);
		painter.draw(delta_label, time_x - delta_time_gap - delta_width,
			     row_top + (row_height - delta_size) * 0.42f, delta_size, FontStyleBold,
			     delta_color, true);
	}

	return copy_bitmap(bitmap, settings.width, output_height, texture_width, texture_height);
}

SourceSettings read_settings(obs_data_t *settings)
{
	SourceSettings result;
	result.backend_url = trim(get_string(settings, SETTING_BACKEND_URL));
	if (result.backend_url.empty())
		result.backend_url = "http://127.0.0.1:5179";
	while (!result.backend_url.empty() && result.backend_url.back() == '/')
		result.backend_url.pop_back();
	result.race_url = trim(get_string(settings, SETTING_RACE_URL));
	result.font_face = utf8_to_wide(trim(get_string(settings, SETTING_FONT_FACE)));
	if (result.font_face.empty())
		result.font_face = L"Segoe UI";
	result.width = static_cast<uint32_t>(clamp_value<int64_t>(obs_data_get_int(settings, SETTING_WIDTH),
								     320, 3840));
	result.row_height = static_cast<uint32_t>(clamp_value<int64_t>(
		obs_data_get_int(settings, SETTING_ROW_HEIGHT), 50, 300));
	result.row_gap = static_cast<uint32_t>(clamp_value<int64_t>(
		obs_data_get_int(settings, SETTING_ROW_GAP), 0, 30));
	result.title_size = static_cast<uint32_t>(clamp_value<int64_t>(
		obs_data_get_int(settings, SETTING_TITLE_SIZE), 12, 160));
	result.font_scale = static_cast<uint32_t>(clamp_value<int64_t>(
		obs_data_get_int(settings, SETTING_FONT_SCALE), 50, 200));
	result.render_scale = static_cast<uint32_t>(clamp_value<int64_t>(
		obs_data_get_int(settings, SETTING_RENDER_SCALE), 100, 300));
	result.background_opacity = static_cast<uint32_t>(clamp_value<int64_t>(
		obs_data_get_int(settings, SETTING_BACKGROUND_OPACITY), 0, 100));
	result.position_opacity = static_cast<uint32_t>(clamp_value<int64_t>(
		obs_data_get_int(settings, SETTING_POSITION_OPACITY), 0, 100));
	if (obs_data_has_user_value(settings, SETTING_GRADIENT_STRENGTH)) {
		result.gradient_strength = static_cast<uint32_t>(clamp_value<int64_t>(
			obs_data_get_int(settings, SETTING_GRADIENT_STRENGTH), 0, 100));
	} else if (obs_data_has_user_value(settings, SETTING_USE_GRADIENT)) {
		result.gradient_strength = obs_data_get_bool(settings, SETTING_USE_GRADIENT) ? 100 : 0;
	}
	result.shadow_offset = static_cast<uint32_t>(clamp_value<int64_t>(
		obs_data_get_int(settings, SETTING_SHADOW_OFFSET), 0, 20));
	result.shadow_blur = static_cast<uint32_t>(clamp_value<int64_t>(
		obs_data_get_int(settings, SETTING_SHADOW_BLUR), 0, 20));
	result.shadow_opacity = static_cast<uint32_t>(clamp_value<int64_t>(
		obs_data_get_int(settings, SETTING_SHADOW_OPACITY), 0, 100));
	result.poll_interval = static_cast<uint32_t>(clamp_value<int64_t>(
		obs_data_get_int(settings, SETTING_POLL_INTERVAL), 250, 5000));
	result.outline_size = static_cast<float>(clamp_value(
		obs_data_get_double(settings, SETTING_OUTLINE_SIZE), 0.0, 10.0));
	result.auto_backend = obs_data_get_bool(settings, SETTING_AUTO_BACKEND);
	result.show_title = obs_data_get_bool(settings, SETTING_SHOW_TITLE);
	return result;
}

class RaceSource {
public:
	RaceSource(obs_data_t *settings, obs_source_t *source)
	{
		update(settings);
		publish(render_message(settings_, "Connecting to TheRun..."));
		showing_.store(obs_source_showing(source));
		sync_backend_registration();
		worker_ = std::thread([this] { worker_loop(); });
	}

	~RaceSource()
	{
		showing_.store(false);
		sync_backend_registration();
		stop_.store(true);
		condition_.notify_all();
		if (worker_.joinable())
			worker_.join();

		obs_enter_graphics();
		gs_texture_destroy(texture_);
		texture_ = nullptr;
		obs_leave_graphics();
	}

	void update(obs_data_t *settings)
	{
		const SourceSettings next = read_settings(settings);
		{
			std::lock_guard lock(settings_mutex_);
			settings_ = next;
			++settings_revision_;
		}
		sync_backend_registration();
		condition_.notify_all();
	}

	void set_showing(bool showing)
	{
		if (showing_.exchange(showing) == showing)
			return;
		sync_backend_registration();
		condition_.notify_all();
	}

	void refresh()
	{
		refresh_requested_.store(true);
		condition_.notify_all();
	}

	uint32_t width() const { return output_width_.load(); }
	uint32_t height() const { return output_height_.load(); }

	void video_render()
	{
		RenderFrame frame;
		uint64_t generation = 0;
		{
			std::lock_guard lock(frame_mutex_);
			if (pending_generation_ > uploaded_generation_) {
				frame = std::move(pending_frame_);
				generation = pending_generation_;
			}
		}

		if (!frame.pixels.empty()) {
			if (!texture_ || texture_width_ != frame.texture_width ||
			    texture_height_ != frame.texture_height) {
				gs_texture_destroy(texture_);
				const uint8_t *levels[] = {frame.pixels.data()};
				texture_ = gs_texture_create(frame.texture_width, frame.texture_height, GS_BGRA,
							     1, levels, GS_DYNAMIC);
				texture_width_ = frame.texture_width;
				texture_height_ = frame.texture_height;
			} else {
				gs_texture_set_image(texture_, frame.pixels.data(), frame.stride, false);
			}
			uploaded_generation_ = generation;
		}

		if (texture_) {
			gs_effect_t *effect = obs_get_base_effect(OBS_EFFECT_PREMULTIPLIED_ALPHA);
			gs_eparam_t *image = gs_effect_get_param_by_name(effect, "image");
			gs_effect_set_texture(image, texture_);
			while (gs_effect_loop(effect, "Draw"))
				obs_source_draw(texture_, 0, 0, output_width_.load(), output_height_.load(),
						false);
		}
	}

private:
	void worker_loop()
	{
		uint64_t observed_revision = 0;
		std::string previous_error;
		RaceData last_data;
		bool have_data = false;
		std::unordered_map<std::string, int64_t> previous_progress;
		std::unordered_map<std::string, std::chrono::steady_clock::time_point> highlights;
		std::string previous_race_id;

		while (!stop_.load()) {
			if (!showing_.load()) {
				std::unique_lock lock(wait_mutex_);
				condition_.wait(lock, [this] { return stop_.load() || showing_.load(); });
				continue;
			}

			SourceSettings settings;
			uint64_t revision = 0;
			{
				std::lock_guard lock(settings_mutex_);
				settings = settings_;
				revision = settings_revision_.load();
			}

			try {
				if (uses_managed_backend(settings))
					BackendManager::instance().ensure_running();
				std::string endpoint = settings.backend_url + "/api/race";
				const std::string race_id = normalize_race_id(settings.race_url);
				if (!race_id.empty())
					endpoint += "?race=" + percent_encode(race_id);

				RaceData race = parse_race_data(http_get_json(endpoint));
				const auto now = std::chrono::steady_clock::now();
				if (race.race_id != previous_race_id) {
					previous_progress.clear();
					highlights.clear();
					previous_race_id = race.race_id;
				}
				for (const RunnerData &runner : race.runners) {
					const auto previous = previous_progress.find(runner.username);
					if (previous != previous_progress.end() &&
					    runner.completed_splits > previous->second) {
						highlights[runner.username] = now + 1500ms;
					}
					previous_progress[runner.username] = runner.completed_splits;
				}

				std::unordered_set<std::string> active_highlights;
				for (auto iterator = highlights.begin(); iterator != highlights.end();) {
					if (iterator->second > now) {
						active_highlights.insert(iterator->first);
						++iterator;
					} else {
						iterator = highlights.erase(iterator);
					}
				}

				publish(render_race(race, settings, active_highlights));
				last_data = std::move(race);
				have_data = true;
				previous_error.clear();
			} catch (const std::exception &error) {
				if (previous_error != error.what()) {
					obs_log(LOG_WARNING, "race update failed: %s", error.what());
					previous_error = error.what();
				}
				if (have_data && revision != observed_revision) {
					publish(render_race(last_data, settings, {}));
				} else if (!have_data) {
					const std::string backend_error = uses_managed_backend(settings)
									  ? BackendManager::instance().last_error()
									  : std::string{};
					publish(render_message(settings, backend_error.empty()
									 ? "Connecting to TheRun..."
									 : backend_error));
				}
			}

			observed_revision = revision;
			refresh_requested_.store(false);
			std::unique_lock lock(wait_mutex_);
			condition_.wait_for(lock, std::chrono::milliseconds(settings.poll_interval),
					    [this, revision] {
						    return stop_.load() || !showing_.load() ||
							   refresh_requested_.load() ||
							   settings_revision_.load() != revision;
					    });
		}
	}

	void sync_backend_registration()
	{
		SourceSettings settings;
		{
			std::lock_guard lock(settings_mutex_);
			settings = settings_;
		}
		const bool should_acquire = showing_.load() && uses_managed_backend(settings);
		std::lock_guard lock(backend_mutex_);
		if (should_acquire == backend_acquired_)
			return;
		if (should_acquire)
			BackendManager::instance().acquire();
		else
			BackendManager::instance().release();
		backend_acquired_ = should_acquire;
	}

	void publish(RenderFrame frame)
	{
		output_width_.store(frame.width);
		output_height_.store(frame.height);
		std::lock_guard lock(frame_mutex_);
		pending_frame_ = std::move(frame);
		++pending_generation_;
	}

	std::atomic<bool> stop_{false};
	std::atomic<bool> showing_{false};
	std::atomic<bool> refresh_requested_{false};
	std::atomic<uint32_t> output_width_{DEFAULT_WIDTH};
	std::atomic<uint32_t> output_height_{180};
	std::thread worker_;
	std::condition_variable condition_;
	std::mutex wait_mutex_;

	std::mutex settings_mutex_;
	SourceSettings settings_;
	std::atomic<uint64_t> settings_revision_{0};
	std::mutex backend_mutex_;
	bool backend_acquired_ = false;

	std::mutex frame_mutex_;
	RenderFrame pending_frame_;
	uint64_t pending_generation_ = 0;
	uint64_t uploaded_generation_ = 0;
	gs_texture_t *texture_ = nullptr;
	uint32_t texture_width_ = 0;
	uint32_t texture_height_ = 0;
};

const char *source_name(void *)
{
	return obs_module_text("TheRunRaceSource");
}

void source_defaults(obs_data_t *settings)
{
	obs_data_set_default_string(settings, SETTING_BACKEND_URL, "http://127.0.0.1:5179");
	obs_data_set_default_bool(settings, SETTING_AUTO_BACKEND, true);
	obs_data_set_default_string(settings, SETTING_RACE_URL, "");
	obs_data_set_default_int(settings, SETTING_WIDTH, DEFAULT_WIDTH);
	obs_data_set_default_int(settings, SETTING_ROW_HEIGHT, DEFAULT_ROW_HEIGHT);
	obs_data_set_default_int(settings, SETTING_ROW_GAP, DEFAULT_ROW_GAP);
	obs_data_set_default_bool(settings, SETTING_SHOW_TITLE, true);
	obs_data_set_default_int(settings, SETTING_TITLE_SIZE, DEFAULT_TITLE_SIZE);
	obs_data_set_default_string(settings, SETTING_FONT_FACE, "Segoe UI");
	obs_data_set_default_int(settings, SETTING_FONT_SCALE, DEFAULT_FONT_SCALE);
	obs_data_set_default_int(settings, SETTING_RENDER_SCALE, DEFAULT_RENDER_SCALE);
	obs_data_set_default_int(settings, SETTING_BACKGROUND_OPACITY, DEFAULT_BACKGROUND_OPACITY);
	obs_data_set_default_int(settings, SETTING_POSITION_OPACITY, DEFAULT_POSITION_OPACITY);
	obs_data_set_default_int(settings, SETTING_GRADIENT_STRENGTH, DEFAULT_GRADIENT_STRENGTH);
	obs_data_set_default_int(settings, SETTING_SHADOW_OFFSET, DEFAULT_SHADOW_OFFSET);
	obs_data_set_default_int(settings, SETTING_SHADOW_BLUR, DEFAULT_SHADOW_BLUR);
	obs_data_set_default_int(settings, SETTING_SHADOW_OPACITY, DEFAULT_SHADOW_OPACITY);
	obs_data_set_default_double(settings, SETTING_OUTLINE_SIZE, DEFAULT_OUTLINE_SIZE);
	obs_data_set_default_int(settings, SETTING_POLL_INTERVAL, DEFAULT_POLL_INTERVAL);
}

bool refresh_clicked(obs_properties_t *, obs_property_t *, void *data)
{
	if (data)
		static_cast<RaceSource *>(data)->refresh();
	return false;
}

obs_properties_t *source_properties(void *data)
{
	obs_properties_t *properties = obs_properties_create();
	obs_properties_t *connection = obs_properties_create();
	obs_properties_add_bool(connection, SETTING_AUTO_BACKEND, obs_module_text("AutoBackend"));
	obs_properties_add_text(connection, SETTING_BACKEND_URL, obs_module_text("BackendUrl"),
				OBS_TEXT_DEFAULT);
	obs_properties_add_text(connection, SETTING_RACE_URL, obs_module_text("RaceUrl"), OBS_TEXT_DEFAULT);
	obs_properties_add_button(connection, "refresh", obs_module_text("Refresh"), refresh_clicked);
	obs_properties_add_int_slider(connection, SETTING_POLL_INTERVAL, obs_module_text("PollInterval"),
				      250, 5000, 250);
	obs_properties_add_group(properties, "connection_group", obs_module_text("ConnectionGroup"),
				 OBS_GROUP_NORMAL, connection);

	obs_properties_t *layout = obs_properties_create();
	obs_properties_add_int_slider(layout, SETTING_WIDTH, obs_module_text("OutputWidth"), 320, 3840,
				      10);
	obs_properties_add_int_slider(layout, SETTING_ROW_HEIGHT, obs_module_text("RowHeight"), 50,
				      300, 2);
	obs_properties_add_int_slider(layout, SETTING_ROW_GAP, obs_module_text("RowGap"), 0, 30, 1);
	obs_properties_add_bool(layout, SETTING_SHOW_TITLE, obs_module_text("ShowTitle"));
	obs_properties_add_int_slider(layout, SETTING_TITLE_SIZE, obs_module_text("TitleFontSize"), 12,
				      160, 1);
	obs_properties_add_text(layout, SETTING_FONT_FACE, obs_module_text("FontFace"), OBS_TEXT_DEFAULT);
	obs_properties_add_int_slider(layout, SETTING_FONT_SCALE, obs_module_text("FontScale"), 50, 200,
				      1);
	obs_properties_add_int_slider(layout, SETTING_RENDER_SCALE, obs_module_text("RenderScale"), 100,
				      300, 25);
	obs_properties_add_group(properties, "layout_group", obs_module_text("LayoutGroup"), OBS_GROUP_NORMAL,
				 layout);

	obs_properties_t *appearance = obs_properties_create();
	obs_properties_add_int_slider(appearance, SETTING_BACKGROUND_OPACITY,
				      obs_module_text("BackgroundOpacity"), 0, 100, 1);
	obs_properties_add_int_slider(appearance, SETTING_POSITION_OPACITY,
				      obs_module_text("PositionOpacity"), 0, 100, 1);
	obs_properties_add_int_slider(appearance, SETTING_GRADIENT_STRENGTH,
				      obs_module_text("GradientStrength"), 0, 100, 1);
	obs_properties_add_int_slider(appearance, SETTING_SHADOW_OFFSET, obs_module_text("ShadowOffset"), 0,
				      20, 1);
	obs_properties_add_int_slider(appearance, SETTING_SHADOW_BLUR, obs_module_text("ShadowBlur"), 0, 20,
				      1);
	obs_properties_add_int_slider(appearance, SETTING_SHADOW_OPACITY,
				      obs_module_text("ShadowOpacity"), 0, 100, 1);
	obs_properties_add_float_slider(appearance, SETTING_OUTLINE_SIZE, obs_module_text("OutlineSize"),
					0.0, 10.0, 0.25);
	obs_properties_add_group(properties, "appearance_group", obs_module_text("AppearanceGroup"),
				 OBS_GROUP_NORMAL, appearance);
	UNUSED_PARAMETER(data);
	return properties;
}

void *source_create(obs_data_t *settings, obs_source_t *source)
{
	try {
		return new RaceSource(settings, source);
	} catch (const std::exception &error) {
		obs_log(LOG_ERROR, "failed to create source: %s", error.what());
		return nullptr;
	}
}

void source_destroy(void *data)
{
	delete static_cast<RaceSource *>(data);
}

void source_update(void *data, obs_data_t *settings)
{
	if (data)
		static_cast<RaceSource *>(data)->update(settings);
}

void source_show(void *data)
{
	if (data)
		static_cast<RaceSource *>(data)->set_showing(true);
}

void source_hide(void *data)
{
	if (data)
		static_cast<RaceSource *>(data)->set_showing(false);
}

uint32_t source_width(void *data)
{
	return data ? static_cast<RaceSource *>(data)->width() : DEFAULT_WIDTH;
}

uint32_t source_height(void *data)
{
	return data ? static_cast<RaceSource *>(data)->height() : 180;
}

void source_render(void *data, gs_effect_t *)
{
	if (data)
		static_cast<RaceSource *>(data)->video_render();
}

} // namespace

void register_therun_race_source()
{
	static obs_source_info info{};
	info.id = SOURCE_ID;
	info.type = OBS_SOURCE_TYPE_INPUT;
	info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW;
	info.get_name = source_name;
	info.create = source_create;
	info.destroy = source_destroy;
	info.update = source_update;
	info.show = source_show;
	info.hide = source_hide;
	info.get_defaults = source_defaults;
	info.get_properties = source_properties;
	info.video_render = source_render;
	info.get_width = source_width;
	info.get_height = source_height;
	info.icon_type = OBS_ICON_TYPE_TEXT;
	obs_register_source(&info);
}
