# FB CRM Studio

Web CRM để đăng bài, bình luận và lập lịch trên Facebook, áp dụng cho **trang cá nhân** và **nhóm**, quản lý được nhiều tài khoản.

## Tính năng

- **Đăng bài** lên trang cá nhân và/hoặc nhiều nhóm cùng lúc, kèm tối đa 10 ảnh/video.
- **Bình luận** vào bài viết (trang cá nhân hoặc nhóm) theo danh sách link, có thể kèm 1 ảnh.
- **Lập lịch**: chạy ngay hoặc hẹn giờ, đặt giãn cách giữa các task, lặp lại hằng ngày/hằng tuần.
- **Tự động chọn và đảo ảnh** từ một kho ảnh (tối đa 50 ảnh):
  - *Dùng tất cả*: mỗi bài dùng cả kho (tối đa 10 ảnh).
  - *Ngẫu nhiên*: mỗi lần chạy tự bốc từ X đến Y ảnh. Bình luận bốc 1 ảnh.
  - *Luân phiên*: bài 1 lấy ảnh 1–2, bài 2 lấy ảnh 3–4, … quay vòng khi hết kho.
  - Có thể bật *Đảo thứ tự ảnh*. Ảnh thực tế đã dùng được lưu trong chi tiết task.
- **Mẫu ảnh**: lưu sẵn các bộ ảnh (tối đa 200 ảnh/mẫu) ở mục *Mẫu ảnh*.
  - Số ảnh bốc mỗi bài được cài trong từng mẫu. Khi đăng bài chỉ cần chọn các mẫu, mỗi lần đăng hệ thống bốc ngẫu nhiên đúng số ảnh đó từ mỗi mẫu (ví dụ 3 ảnh "Sản phẩm" + 2 ảnh "Feedback"). Tổng không vượt 10 ảnh/bài.
  - Bài đã lên lịch dùng ảnh hiện tại của mẫu. Nếu mẫu bị xoá thì dùng bản sao lúc tạo task.
- **Nội dung ngẫu nhiên từ mẫu**: chọn nhiều mẫu nội dung, mỗi lần đăng bốc ngẫu nhiên 1 mẫu **chưa dùng**. Đăng thành công thì mẫu được đánh dấu *đã dùng*. Khi mọi mẫu trong bộ đã dùng thì tự khôi phục về *chưa dùng*. Trang *Mẫu nội dung* hiển thị trạng thái và có nút đặt lại.
- Nhiều nội dung trong một lần tạo (các nội dung cách nhau 1 dòng trống). Có hai chế độ: xoay vòng hoặc dùng tất cả nội dung. Hỗ trợ spintax `{Chào|Xin chào}`.
- Nhiều tài khoản, phân bổ luân phiên hoặc cho mọi tài khoản cùng chạy.
- Hàng đợi task: lọc, tìm kiếm, chọn hàng loạt, chạy, dừng, xoá, chạy lại task lỗi. Xem chi tiết từng task, nhật ký, và ảnh chụp màn hình lúc lỗi.
- Xem lịch chạy theo ngày, quản lý nhóm, mẫu nội dung, nhật ký hoạt động.
- Giới hạn an toàn cho từng tài khoản: khoảng nghỉ tối thiểu, số thao tác tối đa mỗi ngày, số tài khoản chạy song song.

## Cài đặt

Yêu cầu Node.js **22.13 trở lên** (dùng SQLite có sẵn trong Node, không cần cài DB).

```bash
npm run setup     # cài package + Chromium cho Playwright
npm start         # mở http://localhost:3000
```

Đổi cổng bằng biến `PORT`. Server chỉ lắng nghe trên `127.0.0.1`.

## Sử dụng

1. **Tài khoản**: bấm *Thêm tài khoản*, rồi *Đăng nhập*. Một cửa sổ Chromium hiện ra, bạn tự đăng nhập Facebook (kể cả 2FA). Cửa sổ tự đóng khi đăng nhập xong. Cách khác là *Nhập cookie* (JSON từ extension Cookie-Editor).
2. **Nhóm**: thêm link các nhóm mà tài khoản đã tham gia.
3. **Studio**: chọn *Đăng bài* hoặc *Bình luận*, nhập nội dung, chọn tài khoản và thời gian, rồi bấm *Tạo & lên lịch*. Nút *Chỉ thêm vào hàng đợi* tạo task ở trạng thái "Chưa chạy" để bạn bấm *Chạy* sau.
4. Bộ chạy quét hàng đợi mỗi 5 giây. *Dừng tất cả* / *Chạy tiếp* trên thanh trên cùng để bật/tắt.

Khi mới dùng nên **tắt "Chạy ẩn trình duyệt"** trong Cài đặt để xem trực tiếp thao tác.

## Cấu trúc

```
src/server.js   REST API + phục vụ giao diện
src/runner.js   bộ lập lịch, giới hạn theo tài khoản, thử lại, lặp lịch
src/fb.js       tự động hoá Facebook bằng Playwright (đăng nhập, đăng bài, bình luận)
src/db.js       SQLite schema + cài đặt
public/         giao diện (HTML/CSS/JS thuần)
data/           database, ảnh upload, profile trình duyệt, ảnh chụp lỗi (không commit)
```

## Lưu ý quan trọng

- Facebook **không có API chính thức** cho việc đăng lên trang cá nhân hoặc nhóm (Graph API đã gỡ bỏ quyền này), nên hệ thống điều khiển một trình duyệt thật. Tự động hoá có thể vi phạm Điều khoản của Facebook, và tài khoản có thể bị hạn chế tính năng hoặc checkpoint nếu thao tác dày đặc. Hãy dùng với tài khoản của chính bạn, giữ giới hạn thấp và nội dung không spam.
- Giao diện Facebook thay đổi thường xuyên. Nếu task lỗi kiểu "Không tìm thấy khung tạo bài viết / nút Đăng", hãy xem ảnh chụp màn hình lỗi trong chi tiết task, rồi chỉnh các regex/selector ở đầu `src/fb.js` (đối tượng `RX`).
- Thư mục `data/profiles` chứa phiên đăng nhập Facebook, cần bảo mật như mật khẩu.
