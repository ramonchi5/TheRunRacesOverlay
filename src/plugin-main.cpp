/*
TheRun Races Overlay OBS source
Copyright (C) 2026 ramonchi5

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.
*/

#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>

#include <obs-module.h>
#include <plugin-support.h>

#include "race-source.hpp"

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE(PLUGIN_NAME, "en-US")

static ULONG_PTR gdiplus_token = 0;

MODULE_EXPORT const char *obs_module_description(void)
{
	return "Native TheRun race leaderboard source for OBS Studio";
}

bool obs_module_load(void)
{
	Gdiplus::GdiplusStartupInput input;
	if (Gdiplus::GdiplusStartup(&gdiplus_token, &input, nullptr) != Gdiplus::Ok) {
		obs_log(LOG_ERROR, "failed to initialize GDI+");
		return false;
	}

	register_therun_race_source();
	obs_log(LOG_INFO, "native source loaded (version %s)", PLUGIN_VERSION);
	return true;
}

void obs_module_unload(void)
{
	if (gdiplus_token != 0) {
		Gdiplus::GdiplusShutdown(gdiplus_token);
		gdiplus_token = 0;
	}

	obs_log(LOG_INFO, "native source unloaded");
}
