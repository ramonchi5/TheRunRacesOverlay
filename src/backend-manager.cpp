/*
TheRun Races Overlay OBS source
Copyright (C) 2026 ramonchi5

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.
*/

#include "backend-manager.hpp"

#include <winhttp.h>

#include <obs-module.h>
#include <plugin-support.h>

#include <filesystem>
#include <system_error>
#include <vector>

namespace {

std::wstring utf8_to_wide(const std::string &value)
{
	if (value.empty())
		return {};

	const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(),
					 static_cast<int>(value.size()), nullptr, 0);
	if (length <= 0)
		return std::wstring(value.begin(), value.end());

	std::wstring result(static_cast<size_t>(length), L'\0');
	MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(), static_cast<int>(value.size()),
			    result.data(), length);
	return result;
}

std::wstring module_file(const char *relative_path)
{
	char *path = obs_module_file(relative_path);
	if (!path)
		return {};
	const std::wstring result = utf8_to_wide(path);
	bfree(path);
	return result;
}

std::wstring module_config_file(const char *relative_path)
{
	char *path = obs_module_config_path(relative_path);
	if (!path)
		return {};
	const std::wstring result = utf8_to_wide(path);
	bfree(path);
	return result;
}

std::string windows_error(const char *operation)
{
	return std::string(operation) + " failed with Windows error " + std::to_string(GetLastError());
}

} // namespace

BackendManager &BackendManager::instance()
{
	static BackendManager manager;
	return manager;
}

BackendManager::~BackendManager()
{
	std::lock_guard lock(mutex_);
	stop_locked();
}

void BackendManager::acquire()
{
	std::lock_guard lock(mutex_);
	++users_;
}

void BackendManager::release()
{
	std::lock_guard lock(mutex_);
	if (users_ == 0)
		return;
	--users_;
	if (users_ == 0)
		stop_locked();
}

void BackendManager::ensure_running()
{
	std::lock_guard lock(mutex_);
	if (users_ == 0)
		return;

	if (process_) {
		DWORD exit_code = 0;
		if (GetExitCodeProcess(process_, &exit_code) && exit_code == STILL_ACTIVE)
			return;
		obs_log(LOG_WARNING, "bundled backend exited; restarting it");
		clear_process_locked();
	}

	start_locked();
}

std::string BackendManager::last_error() const
{
	std::lock_guard lock(mutex_);
	return last_error_;
}

bool BackendManager::health_check() const
{
	HINTERNET session = WinHttpOpen(L"TheRunRacesOverlay-Backend/3.2.3",
					WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
					WINHTTP_NO_PROXY_BYPASS, 0);
	if (!session)
		return false;
	WinHttpSetTimeouts(session, 300, 300, 300, 300);

	HINTERNET connection = WinHttpConnect(session, L"127.0.0.1", 5179, 0);
	HINTERNET request = connection
				? WinHttpOpenRequest(connection, L"GET", L"/health", nullptr,
						     WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0)
				: nullptr;
	bool healthy = false;
	if (request && WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
					  WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
	    WinHttpReceiveResponse(request, nullptr)) {
		DWORD status = 0;
		DWORD length = sizeof(status);
		healthy = WinHttpQueryHeaders(request,
					      WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
					      WINHTTP_HEADER_NAME_BY_INDEX, &status, &length,
					      WINHTTP_NO_HEADER_INDEX) &&
			  status == 200;
	}

	if (request)
		WinHttpCloseHandle(request);
	if (connection)
		WinHttpCloseHandle(connection);
	WinHttpCloseHandle(session);
	return healthy;
}

void BackendManager::start_locked()
{
	if (users_ == 0 || process_)
		return;
	if (health_check()) {
		owns_process_ = false;
		last_error_.clear();
		obs_log(LOG_INFO, "using an existing local backend on 127.0.0.1:5179");
		return;
	}

	const std::wstring node = module_file("runtime/node.exe");
	const std::wstring server = module_file("backend/server.js");
	const std::wstring state_file = module_config_file("backend-state.json");
	std::error_code node_error;
	std::error_code server_error;
	const bool node_exists = !node.empty() && std::filesystem::is_regular_file(node, node_error);
	const bool server_exists = !server.empty() && std::filesystem::is_regular_file(server, server_error);
	if (!node_exists || !server_exists || state_file.empty()) {
		last_error_ = "The bundled backend files are missing. Reinstall the complete plugin folder.";
		obs_log(LOG_ERROR, "%s", last_error_.c_str());
		return;
	}

	std::error_code directory_error;
	std::filesystem::create_directories(std::filesystem::path(state_file).parent_path(),
					    directory_error);
	if (directory_error) {
		last_error_ = "Could not create the local backend settings folder.";
		obs_log(LOG_ERROR, "%s", last_error_.c_str());
		return;
	}

	const std::wstring command = L"\"" + node + L"\" \"" + server +
				     L"\" --port 5179 --state-file \"" + state_file + L"\"";
	std::vector<wchar_t> command_buffer(command.begin(), command.end());
	command_buffer.push_back(L'\0');

	STARTUPINFOW startup{};
	startup.cb = sizeof(startup);
	startup.dwFlags = STARTF_USESHOWWINDOW;
	startup.wShowWindow = SW_HIDE;
	PROCESS_INFORMATION process_info{};
	const std::wstring working_directory = std::filesystem::path(server).parent_path().wstring();
	if (!CreateProcessW(node.c_str(), command_buffer.data(), nullptr, nullptr, FALSE,
			    CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, working_directory.c_str(),
			    &startup, &process_info)) {
		last_error_ = windows_error("Starting the bundled backend");
		obs_log(LOG_ERROR, "%s", last_error_.c_str());
		return;
	}

	job_ = CreateJobObjectW(nullptr, nullptr);
	JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
	limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
	if (!job_ || !SetInformationJobObject(job_, JobObjectExtendedLimitInformation, &limits,
					       sizeof(limits)) ||
	    !AssignProcessToJobObject(job_, process_info.hProcess)) {
		last_error_ = windows_error("Preparing the bundled backend process");
		TerminateProcess(process_info.hProcess, 1);
		CloseHandle(process_info.hThread);
		CloseHandle(process_info.hProcess);
		if (job_)
			CloseHandle(job_);
		job_ = nullptr;
		obs_log(LOG_ERROR, "%s", last_error_.c_str());
		return;
	}

	process_ = process_info.hProcess;
	if (ResumeThread(process_info.hThread) == static_cast<DWORD>(-1)) {
		last_error_ = windows_error("Resuming the bundled backend process");
		TerminateJobObject(job_, 1);
		CloseHandle(process_info.hThread);
		clear_process_locked();
		obs_log(LOG_ERROR, "%s", last_error_.c_str());
		return;
	}
	CloseHandle(process_info.hThread);
	owns_process_ = true;
	last_error_.clear();
	obs_log(LOG_INFO, "started bundled backend for visible TheRun sources");
}

void BackendManager::stop_locked()
{
	if (owns_process_ && process_) {
		if (job_)
			TerminateJobObject(job_, 0);
		else
			TerminateProcess(process_, 0);
		WaitForSingleObject(process_, 100);
		obs_log(LOG_INFO, "stopped bundled backend because no TheRun sources are visible");
	}
	clear_process_locked();
	owns_process_ = false;
}

void BackendManager::clear_process_locked()
{
	if (process_)
		CloseHandle(process_);
	if (job_)
		CloseHandle(job_);
	process_ = nullptr;
	job_ = nullptr;
}
