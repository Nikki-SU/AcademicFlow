/**
 * File System Access API 类型补充（本地工作区用）
 * ---------------------------------------------------
 * TS 的 lib.dom 已内置 FileSystemHandle / FileSystemDirectoryHandle /
 * FileSystemFileHandle 等基础类型，但缺少：
 *   - Window.showDirectoryPicker（目录授权入口）
 *   - FileSystemHandle.queryPermission / requestPermission（权限查询与申请）
 * 这里做接口合并补齐，仅补"缺的"，不重复定义已存在的类型。
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'write' | 'readwrite'
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

interface DirectoryPickerOptions {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: FileSystemHandle | string
}

interface Window {
  showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>
}
